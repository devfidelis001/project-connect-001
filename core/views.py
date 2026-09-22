import json
import re
from datetime import datetime, timedelta

from django.contrib.auth import authenticate, login as django_login, logout as django_logout
from django.db.models import Count, Q
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from django.utils import timezone

from .models import (
    User, Job, JobLike, JobSave, JobApplication, JobComment, ChatMessage,
    SiteAvailability, DEFAULT_SCHEDULE,
)

# ---------------------------------------------------------------------------
# SITE AVAILABILITY (admin.html controls this; index.html/home.html read it)
# ---------------------------------------------------------------------------
ADMIN_PHONE = '09072825649'
ADMIN_NAME = 'jasmine'


def verify_admin(data):
    """Same phone + daughter's-name check used on admin.html's login gate,
    enforced server-side too so admin actions can't be triggered by anyone
    who didn't actually pass that gate (e.g. by calling the API directly).
    Phone is compared digits-only; name is compared case-insensitively.
    """
    phone = re.sub(r'\D', '', str(data.get('adminPhone') or ''))
    name = str(data.get('adminName') or '').strip().lower()
    return phone == ADMIN_PHONE and name == ADMIN_NAME


def _admin_denied():
    return JsonResponse({'message': 'Incorrect admin phone number or daughter\'s name.'}, status=403)


def _parse_hhmm(value, fallback):
    try:
        return datetime.strptime(value, '%H:%M').time()
    except (TypeError, ValueError):
        return datetime.strptime(fallback, '%H:%M').time()


def _next_open_at(schedule, now_local):
    """First future moment (Lagos time) the schedule says the site should
    be opened, looking up to 8 days ahead. Returns None if no day of the
    week is enabled at all."""
    for offset in range(8):
        day = now_local + timedelta(days=offset)
        day_sched = schedule.get(str(day.weekday())) or {}
        if not day_sched.get('enabled'):
            continue
        open_t = _parse_hhmm(day_sched.get('open'), '09:00')
        candidate = day.replace(hour=open_t.hour, minute=open_t.minute, second=0, microsecond=0)
        if candidate > now_local:
            return candidate
    return None


def compute_site_status():
    avail = SiteAvailability.load()
    now_local = timezone.localtime(timezone.now())
    schedule = avail.schedule or DEFAULT_SCHEDULE

    day_sched = schedule.get(str(now_local.weekday())) or {}
    in_window = False
    if day_sched.get('enabled'):
        open_t = _parse_hhmm(day_sched.get('open'), '09:00')
        close_t = _parse_hhmm(day_sched.get('close'), '18:00')
        in_window = open_t <= now_local.time() < close_t

    if avail.is_open:
        state = 'open'
    elif in_window:
        state = 'opening_soon'
    else:
        state = 'closed'

    next_open = _next_open_at(schedule, now_local)

    return {
        'state': state,
        'isOpen': avail.is_open,
        'inScheduledWindow': in_window,
        'serverTime': now_local.isoformat(),
        'nextOpenAt': next_open.isoformat() if next_open else None,
        'schedule': schedule,
        'closedMessage': avail.closed_message,
    }


def site_status(request):
    return JsonResponse(compute_site_status())


@csrf_exempt
@require_http_methods(["POST"])
def admin_verify(request):
    data = _json_body(request)
    if not verify_admin(data):
        return _admin_denied()
    # The admin unlock is itself a server-side session flag (stored in the
    # django_session table in Postgres) - admin.html never has to remember
    # or resend the phone/name itself after this.
    request.session['admin_verified'] = True
    return JsonResponse({'message': 'Verified'})


@csrf_exempt
@require_http_methods(["GET"])
def admin_status(request):
    return JsonResponse({'verified': is_admin_session(request)})


@csrf_exempt
@require_http_methods(["POST"])
def admin_enter_home(request):
    """The 'Go to Live Home Page' flow on admin.html: verify the phone +
    daughter's name, then log this browser into a real, permanent Admin
    User account (created once, reused after) via a normal Django session
    - same mechanism as any other login, nothing admin.html has to store."""
    data = _json_body(request)
    if not verify_admin(data):
        return _admin_denied()
    admin_user, created = User.objects.get_or_create(
        username='admin@yourlabourmarket.local',
        defaults={
            'email': 'admin@yourlabourmarket.local',
            'full_name': 'Admin',
            'role': 'recruiter',
            'is_verified': True,
            'is_admin_account': True,
        }
    )
    if not created and not admin_user.is_admin_account:
        admin_user.is_admin_account = True
        admin_user.full_name = 'Admin'
        admin_user.save(update_fields=['is_admin_account', 'full_name'])
    django_login(request, admin_user, backend='django.contrib.auth.backends.ModelBackend')
    return JsonResponse({'message': 'Logged in as Admin'})


@csrf_exempt
@require_http_methods(["POST"])
def admin_set_site_open(request):
    if not is_admin_session(request):
        return _admin_denied()
    data = _json_body(request)
    is_open = data.get('isOpen')
    if not isinstance(is_open, bool):
        return JsonResponse({'message': 'isOpen (true/false) is required'}, status=400)
    avail = SiteAvailability.load()
    avail.is_open = is_open
    avail.save(update_fields=['is_open', 'updated_at'])
    return JsonResponse(compute_site_status())


@csrf_exempt
@require_http_methods(["POST"])
def admin_set_schedule(request):
    if not is_admin_session(request):
        return _admin_denied()
    data = _json_body(request)
    schedule = data.get('schedule')
    if not isinstance(schedule, dict):
        return JsonResponse({'message': 'schedule object is required'}, status=400)

    cleaned = {}
    for day in range(7):
        key = str(day)
        entry = schedule.get(key) or {}
        cleaned[key] = {
            'enabled': bool(entry.get('enabled')),
            'open': str(entry.get('open') or '09:00')[:5],
            'close': str(entry.get('close') or '18:00')[:5],
        }

    avail = SiteAvailability.load()
    avail.schedule = cleaned
    if data.get('closedMessage'):
        avail.closed_message = str(data.get('closedMessage'))[:300]
    avail.save(update_fields=['schedule', 'closed_message', 'updated_at'])
    return JsonResponse(compute_site_status())


# ---------------------------------------------------------------------------
# NOTE ON CSRF
# ---------------------------------------------------------------------------
# The frontend (index.html / home.html / admin.html) is a set of plain
# fetch()-based pages with no CSRF token wiring, exactly like the previous
# Node/Express backend it replaces. All JSON API views below are therefore
# marked @csrf_exempt so the existing frontend keeps working unmodified.
# This mirrors the previous backend's security posture; it does not add any
# new exposure.
# ---------------------------------------------------------------------------


def _json_body(request):
    if not request.body:
        return {}
    try:
        return json.loads(request.body.decode('utf-8'))
    except (ValueError, UnicodeDecodeError):
        return {}


def current_user(request):
    """The real, server-verified identity for this request - from the
    Django session (backed by the django_session table in Postgres), never
    from anything the client sent. None if nobody is logged in."""
    return request.user if request.user.is_authenticated else None


def require_login(request):
    """Returns a 401 JsonResponse if nobody is logged in, else None."""
    if not request.user.is_authenticated:
        return JsonResponse({'message': 'Please log in.'}, status=401)
    return None


def is_admin_session(request):
    return request.session.get('admin_verified') is True


def resolve_user(raw_id):
    """Resolve a frontend-supplied id to a real User row.

    The frontend identifies people three different ways depending on the
    page: 'acct-<email>' (the normal case, everywhere in home.html),
    a bare numeric users.id (the admin dashboard's table rows), or a plain
    email. This mirrors resolveUserRow() from the previous Node backend so
    every id shape the frontend already uses keeps working unchanged.

    NOTE: this is only used to resolve a THIRD PARTY someone is referring
    to (e.g. "whose profile am I viewing" or "who is the recruiter in this
    conversation") - never to decide who the acting user is. That always
    comes from current_user(request)/require_login(request) above, i.e.
    the server-side session, never a client-supplied id.
    """
    if raw_id is None:
        return None
    raw_id = str(raw_id).strip()
    if not raw_id:
        return None
    if raw_id.startswith('acct-'):
        email = raw_id[5:].strip().lower()
        if not email:
            return None
        return User.objects.filter(email__iexact=email).first()
    if raw_id.isdigit():
        return User.objects.filter(pk=int(raw_id)).first()
    return User.objects.filter(email__iexact=raw_id.lower()).first()


def external_id(user):
    """The 'acct-<email>' id format the frontend uses everywhere."""
    if not user:
        return None
    if user.email:
        return 'acct-' + user.email.strip().lower()
    return str(user.id)


def user_public_dict(user):
    return {
        'id': external_id(user),
        'name': user.full_name or user.username,
        'phone': user.phone_number,
        'location': user.location,
        'role': user.role,
        'profession': user.profession,
        'skills': user.skills,
        'avatar': user.avatar,
        'verified': bool(user.is_verified),
        'source': 'profile',
    }


# ---------------------------------------------------------------------------
# CURRENT SESSION ("who am I")
# The browser never stores identity/profile/settings itself - every page
# load, home.html/index.html asks the server via GET /api/me/, which reads
# the Django session (backed by Postgres) and answers from there.
# ---------------------------------------------------------------------------

def me(request):
    user = current_user(request)
    if not user:
        return JsonResponse({'authenticated': False})
    return JsonResponse({
        'authenticated': True,
        'id': external_id(user),
        'email': user.email,
        'name': user.full_name,
        'phone': user.phone_number,
        'location': user.location,
        'profession': user.profession,
        'skills': user.skills,
        'role': user.role,
        'avatar': user.avatar,
        'suspended': user.suspended,
        'verified': bool(user.is_verified),
        'isAdminAccount': user.is_admin_account,
        'settings': user.settings or {},
        'seenJobIds': user.seen_job_ids or [],
    })


@csrf_exempt
@require_http_methods(["POST"])
def me_settings(request):
    denied = require_login(request)
    if denied:
        return denied
    data = _json_body(request)
    settings_obj = data.get('settings')
    if not isinstance(settings_obj, dict):
        return JsonResponse({'message': 'settings object is required'}, status=400)
    request.user.settings = settings_obj
    request.user.save(update_fields=['settings'])
    return JsonResponse({'message': 'Settings saved'})


@csrf_exempt
@require_http_methods(["POST"])
def me_seen_jobs(request):
    denied = require_login(request)
    if denied:
        return denied
    data = _json_body(request)
    seen = data.get('seenJobIds')
    if not isinstance(seen, list):
        return JsonResponse({'message': 'seenJobIds array is required'}, status=400)
    request.user.seen_job_ids = seen
    request.user.save(update_fields=['seen_job_ids'])
    return JsonResponse({'message': 'Saved'})


def job_to_dict(job, like_count=None, comment_count=None, liked=False, saved=False, applied=False):
    return {
        'id': job.id,
        'userId': external_id(job.user),
        'company': job.company,
        'title': job.title,
        'location': job.location,
        'salary': job.salary,
        'description': job.description,
        'attachment': job.attachment,
        'createdAt': job.created_at.isoformat() if job.created_at else None,
        'isNew': job.is_new,
        'authorName': job.author_name or job.company,
        'authorPhone': job.author_phone,
        'authorLocation': job.author_location or job.location,
        'authorAvatar': job.author_avatar,
        'authorRole': job.author_role,
        'authorSkills': job.author_skills,
        'authorVerified': bool(job.user.is_verified) if job.user_id else False,
        'likeCount': job.like_count if like_count is None else like_count,
        'likedByMe': bool(liked),
        'commentCount': job.comment_count if comment_count is None else comment_count,
        'savedByMe': bool(saved),
        'appliedByMe': bool(applied),
    }


def annotate_jobs(qs):
    return qs.select_related('user').annotate(
        like_count=Count('likes', distinct=True),
        comment_count=Count('comments', distinct=True),
    )


def jobs_to_list(qs, viewer):
    qs = annotate_jobs(qs)
    liked_ids = saved_ids = applied_ids = frozenset()
    if viewer:
        liked_ids = frozenset(JobLike.objects.filter(user=viewer).values_list('job_id', flat=True))
        saved_ids = frozenset(JobSave.objects.filter(user=viewer).values_list('job_id', flat=True))
        applied_ids = frozenset(JobApplication.objects.filter(user=viewer).values_list('job_id', flat=True))
    return [
        job_to_dict(
            job,
            liked=job.id in liked_ids,
            saved=job.id in saved_ids,
            applied=job.id in applied_ids,
        )
        for job in qs
    ]


def comment_to_dict(c):
    return {
        'id': c.id,
        'jobId': c.job_id,
        'userId': external_id(c.user) if c.user_id else None,
        'author': c.author_name,
        'authorAvatar': c.author_avatar,
        'authorVerified': bool(c.user.is_verified) if c.user_id else False,
        'text': c.text,
        'createdAt': c.created_at.isoformat() if c.created_at else None,
    }


def message_to_dict(m):
    return {
        'id': m.id,
        'jobId': m.job_id,
        'recruiterId': external_id(m.recruiter),
        'seekerId': external_id(m.seeker),
        'senderId': external_id(m.sender),
        'senderRole': m.sender_role,
        'senderName': m.sender_name,
        'senderAvatar': m.sender_avatar,
        'senderVerified': bool(m.sender.is_verified),
        'text': m.text,
        'createdAt': m.created_at.isoformat() if m.created_at else None,
        'readBySeeker': m.read_by_seeker,
        'readByRecruiter': m.read_by_recruiter,
    }


# ---------------------------------------------------------------------------
# Basic
# ---------------------------------------------------------------------------

def api_status(request):
    return JsonResponse({'status': 'Online', 'message': 'Your Labour Market API is working'})


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@csrf_exempt
def signup(request):
    if request.method != "POST":
        return JsonResponse({"error": "Only POST requests are allowed."}, status=405)

    status = compute_site_status()
    if status['state'] != 'open':
        return JsonResponse({
            "error": status['closedMessage'] if status['state'] == 'opening_soon' else "Website is currently closed.",
            "siteStatus": status,
        }, status=423)

    try:
        data = _json_body(request)

        full_name = data.get("full_name", "").strip()
        email = data.get("email", "").strip().lower()
        phone_number = data.get("phone_number", "").strip()
        role = data.get("role", "").strip()
        location = data.get("location", "").strip()
        profession = data.get("profession", "").strip()
        password = data.get("password", "")

        if not full_name or not email or not password:
            return JsonResponse({"error": "Full name, email and password are required."}, status=400)

        if User.objects.filter(email__iexact=email).exists():
            return JsonResponse({"error": "An account with this email already exists."}, status=400)

        if role not in ["job_seeker", "recruiter"]:
            return JsonResponse({"error": "Invalid account type."}, status=400)

        user = User.objects.create_user(
            username=email,
            email=email,
            password=password,
            full_name=full_name,
            phone_number=phone_number,
            role=role,
            location=location,
            profession=profession,
        )

        django_login(request, user, backend='django.contrib.auth.backends.ModelBackend')

        return JsonResponse({"message": "Account created successfully.", "user_id": user.id}, status=201)

    except Exception as error:
        return JsonResponse({"error": str(error)}, status=500)


@csrf_exempt
def login_view(request):
    if request.method != "POST":
        return JsonResponse({"message": "Only POST requests are allowed."}, status=405)

    status = compute_site_status()
    if status['state'] != 'open':
        return JsonResponse({
            "message": status['closedMessage'] if status['state'] == 'opening_soon' else "Website is currently closed.",
            "siteStatus": status,
        }, status=423)

    try:
        data = _json_body(request)
        email = (data.get("email") or "").strip().lower()
        password = data.get("password") or ""
        if not email or not password:
            return JsonResponse({"message": "Email and password are required."}, status=400)

        try:
            user_row = User.objects.get(email__iexact=email)
        except User.DoesNotExist:
            return JsonResponse({"message": "Account not found"}, status=404)

        user = authenticate(request, username=user_row.username, password=password)
        if user is None:
            return JsonResponse({"message": "Incorrect password"}, status=401)

        django_login(request, user)

        return JsonResponse({
            "message": "Login successful",
            "user": {
                "id": external_id(user),
                "email": user.email,
                "fullname": user.full_name,
                "phone": user.phone_number,
                "accounttype": user.role,
                "location": user.location,
                "profession": user.profession,
                "skills": user.skills,
                "avatar": user.avatar,
                "suspended": user.suspended,
            }
        })
    except Exception as error:
        return JsonResponse({"message": str(error)}, status=500)


@csrf_exempt
def logout_view(request):
    django_logout(request)
    return JsonResponse({"message": "Logged out"})


def session_status(request, user_key):
    user = resolve_user(user_key)
    if not user:
        return JsonResponse({"exists": False, "suspended": False})
    return JsonResponse({
        "exists": True,
        "suspended": bool(user.suspended),
        "id": external_id(user),
        "name": user.full_name,
        "email": user.email,
    })


# ---------------------------------------------------------------------------
# Users / profile / admin
# ---------------------------------------------------------------------------

@csrf_exempt
def sync_profile(request):
    if request.method != "POST":
        return JsonResponse({"message": "Only POST requests are allowed."}, status=405)
    denied = require_login(request)
    if denied:
        return denied
    user = request.user
    data = _json_body(request)

    name = data.get("name") or "Anonymous"
    phone = data.get("phone") or ""
    location = data.get("location") or ""
    skills = data.get("skills") or ""
    role = data.get("role") or "Jobseeker"
    avatar = data.get("avatar") or ""

    user.full_name = name
    user.phone_number = phone
    user.location = location
    user.skills = skills
    # role here is the free-text display role from the profile form
    # ("Jobseeker", "Recruiter", etc.) which may not match the strict
    # job_seeker/recruiter choices - only write it back if it matches.
    if role.lower().replace(' ', '_') in ('job_seeker', 'recruiter'):
        user.role = role.lower().replace(' ', '_')
    user.avatar = avatar
    user.save()

    # Cascade the new profile onto every job this person has posted, so it
    # shows up everywhere immediately - not just here.
    Job.objects.filter(user=user).update(
        company=name,
        author_name=name,
        author_phone=phone,
        author_location=location,
        author_avatar=avatar,
        author_role=role,
        author_skills=skills,
    )

    return JsonResponse({"message": "Profile updated successfully and propagated to all existing posts."})


def list_users(request):
    if not is_admin_session(request):
        return _admin_denied()
    users = User.objects.all().order_by('-id')
    return JsonResponse([
        {
            'id': u.id,
            'name': u.full_name,
            'email': u.email,
            'phone': u.phone_number,
            'role': u.role,
            'location': u.location,
            'profession': u.profession,
            'skills': u.skills,
            'avatar': u.avatar,
            'createdAt': u.created_at.isoformat() if u.created_at else None,
            'suspended': bool(u.suspended),
            'verified': bool(u.is_verified),
        }
        for u in users
    ], safe=False)


def search_users(request):
    denied = require_login(request)
    if denied:
        return denied
    q = (request.GET.get('q') or '').strip()
    if not q:
        return JsonResponse([], safe=False)
    users = User.objects.filter(
        Q(full_name__icontains=q) | Q(profession__icontains=q) | Q(skills__icontains=q) |
        Q(location__icontains=q) | Q(role__icontains=q)
    ).order_by('full_name')[:30]
    return JsonResponse([
        {
            'id': external_id(u),
            'name': u.full_name,
            'phone': u.phone_number,
            'role': u.role,
            'location': u.location,
            'profession': u.profession,
            'skills': u.skills,
            'avatar': u.avatar,
            'verified': bool(u.is_verified),
        }
        for u in users
    ], safe=False)


def public_profile(request, user_id):
    denied = require_login(request)
    if denied:
        return denied
    user = resolve_user(user_id)
    if user:
        return JsonResponse(user_public_dict(user))
    return JsonResponse({"message": "User not found"}, status=404)


def user_posts(request, user_id):
    denied = require_login(request)
    if denied:
        return denied
    user = resolve_user(user_id)
    if not user:
        return JsonResponse([], safe=False)
    qs = Job.objects.filter(user=user).order_by('-created_at')
    return JsonResponse(jobs_to_list(qs, request.user), safe=False)


def user_liked(request, user_id):
    denied = require_login(request)
    if denied:
        return denied
    user = resolve_user(user_id)
    if not user or user.id != request.user.id:
        return JsonResponse({"message": "You can only view your own liked jobs."}, status=403)
    job_ids = list(JobLike.objects.filter(user=user).order_by('-created_at').values_list('job_id', flat=True))
    jobs = jobs_to_list(Job.objects.filter(id__in=job_ids), request.user)
    by_id = {j['id']: j for j in jobs}
    return JsonResponse([by_id[jid] for jid in job_ids if jid in by_id], safe=False)


def user_saved(request, user_id):
    denied = require_login(request)
    if denied:
        return denied
    user = resolve_user(user_id)
    if not user or user.id != request.user.id:
        return JsonResponse({"message": "You can only view your own saved jobs."}, status=403)
    job_ids = list(JobSave.objects.filter(user=user).order_by('-created_at').values_list('job_id', flat=True))
    jobs = jobs_to_list(Job.objects.filter(id__in=job_ids), request.user)
    by_id = {j['id']: j for j in jobs}
    return JsonResponse([by_id[jid] for jid in job_ids if jid in by_id], safe=False)


def user_applications(request, user_id):
    denied = require_login(request)
    if denied:
        return denied
    user = resolve_user(user_id)
    if not user or user.id != request.user.id:
        return JsonResponse({"message": "You can only view your own applications."}, status=403)
    applications = JobApplication.objects.filter(user=user).order_by('-created_at')
    job_ids = [a.job_id for a in applications]
    jobs = jobs_to_list(Job.objects.filter(id__in=job_ids), request.user)
    by_id = {j['id']: j for j in jobs}
    applied_at = {a.job_id: a.created_at.isoformat() for a in applications}
    result = []
    for jid in job_ids:
        if jid in by_id:
            entry = dict(by_id[jid])
            entry['appliedAt'] = applied_at.get(jid)
            result.append(entry)
    return JsonResponse(result, safe=False)


@csrf_exempt
@require_http_methods(["DELETE"])
def delete_user(request, user_id):
    if not is_admin_session(request):
        return _admin_denied()
    user = resolve_user(user_id)
    if not user:
        return JsonResponse({"message": "User not found"}, status=404)
    user.delete()
    return JsonResponse({"message": "User deleted successfully"})


@csrf_exempt
@require_http_methods(["PATCH"])
def suspend_user(request, user_id):
    if not is_admin_session(request):
        return _admin_denied()
    data = _json_body(request)
    suspended = data.get("suspended")
    if not isinstance(suspended, bool):
        return JsonResponse({"message": "suspended (true/false) is required"}, status=400)
    user = resolve_user(user_id)
    if not user:
        return JsonResponse({"message": "User not found"}, status=404)
    user.suspended = suspended
    user.save(update_fields=['suspended'])
    return JsonResponse({
        "message": "User suspended successfully" if suspended else "User unsuspended successfully",
        "id": user.id,
        "suspended": user.suspended,
    })


@csrf_exempt
@require_http_methods(["PATCH"])
def set_user_verified(request, user_id):
    """Admin-only toggle for the Blue Verification Badge. Gated the same
    way as suspend_user/delete_user - only a verified admin session can
    call this, so a normal user (even editing their own profile via
    sync_profile) has no path that can ever change is_verified."""
    if not is_admin_session(request):
        return _admin_denied()
    data = _json_body(request)
    verified = data.get("verified")
    if not isinstance(verified, bool):
        return JsonResponse({"message": "verified (true/false) is required"}, status=400)
    user = resolve_user(user_id)
    if not user:
        return JsonResponse({"message": "User not found"}, status=404)
    user.is_verified = verified
    user.save(update_fields=['is_verified'])
    return JsonResponse({
        "message": "User verified successfully" if verified else "Verification removed",
        "id": user.id,
        "verified": user.is_verified,
    })


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

@csrf_exempt
def jobs_collection(request):
    if request.method == "GET":
        # Reachable either as a logged-in user browsing the feed, or as
        # someone who passed the admin.html dashboard gate (which doesn't
        # log them in as a User - it's a separate, lighter check).
        if not request.user.is_authenticated and not is_admin_session(request):
            return JsonResponse({'message': 'Please log in.'}, status=401)
        viewer = request.user if request.user.is_authenticated else None
        qs = Job.objects.all().order_by('-created_at')
        return JsonResponse(jobs_to_list(qs, viewer), safe=False)

    if request.method == "POST":
        denied = require_login(request)
        if denied:
            return denied
        author = request.user
        if author.suspended:
            return JsonResponse({"message": "Your account is suspended. You can't post jobs right now."}, status=403)

        data = _json_body(request)
        job_id = data.get("id")
        title = (data.get("title") or "").strip()
        if not job_id or not title:
            return JsonResponse({"message": "Missing required job fields (id, title)"}, status=400)

        # Job content (company/title/location/etc.) comes from the form,
        # but WHO posted it - the author_* snapshot fields - always comes
        # from the logged-in user's real profile, never from the request
        # body, so nobody can post a job under someone else's name/photo.
        defaults = {
            'user': author,
            'company': data.get('company') or author.full_name or 'Anonymous',
            'title': title,
            'location': data.get('location') or '',
            'salary': data.get('salary') or '',
            'description': data.get('description') or '',
            'attachment': data.get('attachment'),
            'is_new': bool(data.get('isNew')),
            'author_name': author.full_name or 'Anonymous',
            'author_phone': author.phone_number or '',
            'author_location': author.location or '',
            'author_avatar': author.avatar or '',
            'author_role': author.role or 'Jobseeker',
            'author_skills': author.skills or '',
        }
        job, _ = Job.objects.update_or_create(id=job_id, defaults=defaults)
        result = jobs_to_list(Job.objects.filter(id=job.id), author)
        return JsonResponse({"message": "Job saved successfully", "job": result[0] if result else None}, status=201)

    return JsonResponse({"message": "Method not allowed"}, status=405)


@csrf_exempt
@require_http_methods(["DELETE"])
def job_detail(request, job_id):
    if not is_admin_session(request):
        return _admin_denied()
    deleted, _ = Job.objects.filter(id=job_id).delete()
    if not deleted:
        return JsonResponse({"message": "Job not found"}, status=404)
    return JsonResponse({"message": "Job deleted successfully"})


@csrf_exempt
@require_http_methods(["POST"])
def job_like(request, job_id):
    denied = require_login(request)
    if denied:
        return denied
    user = request.user
    job = Job.objects.filter(id=job_id).first()
    if not job:
        return JsonResponse({"message": "Job not found"}, status=404)

    existing = JobLike.objects.filter(job=job, user=user).first()
    if existing:
        existing.delete()
        liked = False
    else:
        JobLike.objects.create(job=job, user=user)
        liked = True

    return JsonResponse({"liked": liked, "likeCount": JobLike.objects.filter(job=job).count()})


@csrf_exempt
@require_http_methods(["POST"])
def job_save(request, job_id):
    denied = require_login(request)
    if denied:
        return denied
    user = request.user
    job = Job.objects.filter(id=job_id).first()
    if not job:
        return JsonResponse({"message": "Job not found"}, status=404)

    existing = JobSave.objects.filter(job=job, user=user).first()
    if existing:
        existing.delete()
        saved = False
    else:
        JobSave.objects.create(job=job, user=user)
        saved = True

    return JsonResponse({"saved": saved})


@csrf_exempt
@require_http_methods(["POST"])
def job_apply(request, job_id):
    denied = require_login(request)
    if denied:
        return denied
    user = request.user
    if user.suspended:
        return JsonResponse({"message": "Your account is suspended. You can't apply to jobs right now."}, status=403)
    job = Job.objects.filter(id=job_id).first()
    if not job:
        return JsonResponse({"message": "Job not found"}, status=404)

    existing = JobApplication.objects.filter(job=job, user=user).first()
    if existing:
        existing.delete()
        applied = False
    else:
        JobApplication.objects.create(job=job, user=user)
        applied = True

    return JsonResponse({"applied": applied})


@csrf_exempt
def job_comments(request, job_id):
    job = Job.objects.filter(id=job_id).first()
    if not job:
        return JsonResponse({"message": "Job not found"}, status=404)

    if request.method == "GET":
        denied = require_login(request)
        if denied:
            return denied
        comments = JobComment.objects.filter(job=job).select_related('user').order_by('id')
        return JsonResponse([comment_to_dict(c) for c in comments], safe=False)

    if request.method == "POST":
        denied = require_login(request)
        if denied:
            return denied
        user = request.user
        if user.suspended:
            return JsonResponse({"message": "Your account is suspended. You can't comment right now."}, status=403)

        data = _json_body(request)
        text = (data.get("text") or "").strip()
        if not text:
            return JsonResponse({"message": "Comment text is required"}, status=400)

        comment = JobComment.objects.create(
            job=job,
            user=user,
            author_name=user.full_name or "Anonymous",
            author_avatar=user.avatar or "",
            text=text,
        )
        return JsonResponse(comment_to_dict(comment), status=201)

    return JsonResponse({"message": "Method not allowed"}, status=405)


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------

@csrf_exempt
def chat_messages(request, recruiter_id, seeker_id):
    denied = require_login(request)
    if denied:
        return denied
    recruiter = resolve_user(recruiter_id)
    seeker = resolve_user(seeker_id)
    if not recruiter or not seeker:
        return JsonResponse({"message": "Unknown recruiter or seeker"}, status=404)
    if request.user.id not in (recruiter.id, seeker.id):
        return JsonResponse({"message": "You're not part of this conversation."}, status=403)

    if request.method == "GET":
        msgs = ChatMessage.objects.filter(recruiter=recruiter, seeker=seeker).select_related('sender').order_by('id')
        return JsonResponse([message_to_dict(m) for m in msgs], safe=False)

    if request.method == "POST":
        sender = request.user
        if sender.suspended:
            return JsonResponse({"message": "Your account is suspended. You can't send messages right now."}, status=403)
        # Which side of the conversation the sender is on is derived from
        # who they actually are (matched against the URL), never trusted
        # from the request body.
        sender_role = 'recruiter' if sender.id == recruiter.id else 'seeker'

        data = _json_body(request)
        text = (data.get("text") or "").strip()
        if not text:
            return JsonResponse({"message": "text is required"}, status=400)

        job = Job.objects.filter(id=data.get("jobId")).first() if data.get("jobId") else None

        msg = ChatMessage.objects.create(
            job=job,
            recruiter=recruiter,
            seeker=seeker,
            sender=sender,
            sender_role=sender_role,
            sender_name=sender.full_name or "",
            sender_avatar=sender.avatar or "",
            text=text,
            read_by_seeker=(sender_role == "seeker"),
            read_by_recruiter=(sender_role == "recruiter"),
        )
        return JsonResponse(message_to_dict(msg), status=201)

    return JsonResponse({"message": "Method not allowed"}, status=405)


@csrf_exempt
@require_http_methods(["POST"])
def chat_mark_read(request, recruiter_id, seeker_id):
    denied = require_login(request)
    if denied:
        return denied
    recruiter = resolve_user(recruiter_id)
    seeker = resolve_user(seeker_id)
    if not recruiter or not seeker:
        return JsonResponse({"message": "Could not mark as read"}, status=404)
    if request.user.id not in (recruiter.id, seeker.id):
        return JsonResponse({"message": "You're not part of this conversation."}, status=403)
    field = 'read_by_recruiter' if request.user.id == recruiter.id else 'read_by_seeker'
    ChatMessage.objects.filter(recruiter=recruiter, seeker=seeker).update(**{field: True})
    return JsonResponse({"message": "Marked as read"})


@csrf_exempt
@require_http_methods(["DELETE"])
def chat_delete(request, recruiter_id, seeker_id):
    denied = require_login(request)
    if denied:
        return denied
    recruiter = resolve_user(recruiter_id)
    seeker = resolve_user(seeker_id)
    if not recruiter or not seeker:
        return JsonResponse({"message": "Conversation deleted successfully"})
    if request.user.id not in (recruiter.id, seeker.id):
        return JsonResponse({"message": "You're not part of this conversation."}, status=403)
    ChatMessage.objects.filter(recruiter=recruiter, seeker=seeker).delete()
    return JsonResponse({"message": "Conversation deleted successfully"})


def user_conversations(request, user_id):
    denied = require_login(request)
    if denied:
        return denied
    user = resolve_user(user_id)
    if not user or user.id != request.user.id:
        return JsonResponse({"message": "You can only view your own conversations."}, status=403)

    pairs = ChatMessage.objects.filter(Q(seeker=user) | Q(recruiter=user)) \
        .values_list('recruiter_id', 'seeker_id').distinct()

    conversations = []
    for recruiter_pk, seeker_pk in pairs:
        is_recruiter = recruiter_pk == user.id
        my_role = 'recruiter' if is_recruiter else 'seeker'

        thread = ChatMessage.objects.filter(recruiter_id=recruiter_pk, seeker_id=seeker_pk)
        last_msg = thread.order_by('-id').first()
        last_job_msg = thread.filter(job__isnull=False).order_by('-id').first()
        last_job = last_job_msg.job if last_job_msg else None
        distinct_job_count = thread.filter(job__isnull=False).values('job_id').distinct().count()

        unread_field = 'read_by_recruiter' if is_recruiter else 'read_by_seeker'
        unread_count = thread.filter(**{unread_field: False}).exclude(sender_role=my_role).count()

        recruiter_user = User.objects.filter(pk=recruiter_pk).first()
        seeker_user = User.objects.filter(pk=seeker_pk).first()

        if is_recruiter:
            seeker_msg = thread.filter(sender_role='seeker').order_by('-id').first()
            counterpart_name = (seeker_msg.sender_name if seeker_msg else None) or 'Applicant'
            counterpart_avatar = (seeker_msg.sender_avatar if seeker_msg else '') or ''
        else:
            if recruiter_user:
                counterpart_name = recruiter_user.full_name
                counterpart_avatar = recruiter_user.avatar or ''
            else:
                counterpart_name = (last_job.author_name if last_job else None) or (last_job.company if last_job else None) or 'Recruiter'
                counterpart_avatar = (last_job.author_avatar if last_job else '') or ''

        job_title = ''
        if last_job:
            job_title = last_job.title
            if distinct_job_count > 1:
                job_title += ' (+{} more)'.format(distinct_job_count - 1)

        conversations.append({
            'recruiterId': external_id(recruiter_user) if recruiter_user else str(recruiter_pk),
            'seekerId': external_id(seeker_user) if seeker_user else str(seeker_pk),
            'jobId': last_job.id if last_job else '',
            'jobTitle': job_title,
            'company': last_job.company if last_job else '',
            'myRole': my_role,
            'counterpartName': counterpart_name,
            'counterpartAvatar': counterpart_avatar,
            'lastMessage': last_msg.text if last_msg else '',
            'lastSenderRole': last_msg.sender_role if last_msg else '',
            'lastAt': last_msg.created_at.isoformat() if last_msg else '',
            'unreadCount': unread_count,
        })

    conversations.sort(key=lambda c: c['lastAt'], reverse=True)
    return JsonResponse(conversations, safe=False)
