from django.contrib.auth.models import AbstractUser
from django.db import models


# Default weekly schedule: Monday-Friday 09:00-18:00, weekends closed.
# Keyed by Python's weekday() numbering: 0=Monday ... 6=Sunday.
DEFAULT_SCHEDULE = {
    str(day): {
        'enabled': day < 5,
        'open': '09:00',
        'close': '18:00',
    }
    for day in range(7)
}

DEFAULT_CLOSED_MESSAGE = (
    "Website will be opened soon, please wait a moment or call "
    "+2349072825649 for enquiries."
)


class SiteAvailability(models.Model):
    """Singleton row (always pk=1) controlling whether the site is
    actually reachable for signup/login/home right now.

    is_open is the REAL, live switch - only ever changed by the admin
    clicking Open/Close on admin.html. schedule is just the *expected*
    weekly window, used to show a countdown and an "opening soon" vs
    "closed" message to visitors - it does not flip is_open by itself.
    """
    is_open = models.BooleanField(default=False)
    schedule = models.JSONField(default=dict)
    closed_message = models.CharField(max_length=300, blank=True, default=DEFAULT_CLOSED_MESSAGE)
    updated_at = models.DateTimeField(auto_now=True)

    @classmethod
    def load(cls):
        obj, created = cls.objects.get_or_create(
            pk=1,
            defaults={'schedule': DEFAULT_SCHEDULE, 'closed_message': DEFAULT_CLOSED_MESSAGE}
        )
        if not obj.schedule:
            obj.schedule = DEFAULT_SCHEDULE
            obj.save(update_fields=['schedule'])
        return obj


class User(AbstractUser):
    ROLE_CHOICES = (
        ('job_seeker', 'Job Seeker'),
        ('recruiter', 'Recruiter'),
    )

    full_name = models.CharField(max_length=150)
    phone_number = models.CharField(max_length=20, blank=True)
    role = models.CharField(max_length=20, choices=ROLE_CHOICES, default='job_seeker')
    location = models.CharField(max_length=150, blank=True)
    profession = models.CharField(max_length=150, blank=True)
    skills = models.TextField(blank=True)
    avatar = models.TextField(blank=True)
    is_verified = models.BooleanField(default=False)
    suspended = models.BooleanField(default=False)
    is_admin_account = models.BooleanField(default=False)
    settings = models.JSONField(default=dict, blank=True)
    seen_job_ids = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.username


class Job(models.Model):
    id = models.CharField(max_length=100, primary_key=True)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='jobs')
    company = models.CharField(max_length=200, blank=True)
    title = models.CharField(max_length=200)
    location = models.CharField(max_length=150, blank=True)
    salary = models.CharField(max_length=150, blank=True)
    description = models.TextField()
    attachment = models.JSONField(blank=True, null=True)
    is_new = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    # Author snapshot fields - the job card shows whoever posted it AS OF
    # THAT MOMENT. When a user edits their profile, we cascade the new
    # values onto every job they've posted (see sync_profile view) so old
    # posts stay up to date, exactly like the previous Node backend did.
    author_name = models.CharField(max_length=200, blank=True)
    author_phone = models.CharField(max_length=20, blank=True)
    author_location = models.CharField(max_length=150, blank=True)
    author_avatar = models.TextField(blank=True)
    author_role = models.CharField(max_length=50, blank=True)
    author_skills = models.TextField(blank=True)

    def __str__(self):
        return self.title


class JobLike(models.Model):
    job = models.ForeignKey(Job, on_delete=models.CASCADE, related_name='likes')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='job_likes')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['job', 'user'],
                name='unique_job_like'
            )
        ]


class JobSave(models.Model):
    job = models.ForeignKey(Job, on_delete=models.CASCADE, related_name='saves')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='job_saves')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['job', 'user'],
                name='unique_job_save'
            )
        ]


class JobApplication(models.Model):
    job = models.ForeignKey(Job, on_delete=models.CASCADE, related_name='applications')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='applications')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['job', 'user'],
                name='unique_job_application'
            )
        ]


class JobComment(models.Model):
    job = models.ForeignKey(Job, on_delete=models.CASCADE, related_name='comments')
    user = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True)
    author_name = models.CharField(max_length=150, blank=True)
    author_avatar = models.TextField(blank=True)
    text = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)


class ChatMessage(models.Model):
    # A conversation is between two PEOPLE - recruiter and seeker - not
    # scoped to one job post. job is optional context only (which job the
    # message was about / the "View Tagged Job" link).
    job = models.ForeignKey(Job, on_delete=models.SET_NULL, null=True, blank=True, related_name='chat_messages')
    recruiter = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='recruiter_messages'
    )
    seeker = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='seeker_messages'
    )
    sender = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='sent_messages'
    )
    sender_role = models.CharField(max_length=20)
    sender_name = models.CharField(max_length=150, blank=True)
    sender_avatar = models.TextField(blank=True)
    text = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    read_by_seeker = models.BooleanField(default=False)
    read_by_recruiter = models.BooleanField(default=False)

    class Meta:
        ordering = ['created_at']
