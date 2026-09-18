from django.urls import path
from . import views

urlpatterns = [
    path('api/status/', views.api_status, name='api_status'),

    # Site availability (admin-controlled open/close + schedule)
    path('api/site-status/', views.site_status, name='site_status'),
    path('api/admin/verify/', views.admin_verify, name='admin_verify'),
    path('api/admin/status/', views.admin_status, name='admin_status'),
    path('api/admin/enter-home/', views.admin_enter_home, name='admin_enter_home'),
    path('api/admin/site-open/', views.admin_set_site_open, name='admin_set_site_open'),
    path('api/admin/site-schedule/', views.admin_set_schedule, name='admin_set_schedule'),

    # Auth / current session
    path('api/signup/', views.signup, name='signup'),
    path('api/login/', views.login_view, name='login'),
    path('api/logout/', views.logout_view, name='logout'),
    path('api/session-status/<str:user_key>/', views.session_status, name='session_status'),
    path('api/me/', views.me, name='me'),
    path('api/me/settings/', views.me_settings, name='me_settings'),
    path('api/me/seen-jobs/', views.me_seen_jobs, name='me_seen_jobs'),

    # Users / profile / admin
    path('api/users/', views.list_users, name='list_users'),
    path('api/users/search/', views.search_users, name='search_users'),
    path('api/users/profile/', views.sync_profile, name='sync_profile'),
    path('api/users/<str:user_id>/public-profile/', views.public_profile, name='public_profile'),
    path('api/users/<str:user_id>/posts/', views.user_posts, name='user_posts'),
    path('api/users/<str:user_id>/liked/', views.user_liked, name='user_liked'),
    path('api/users/<str:user_id>/saved/', views.user_saved, name='user_saved'),
    path('api/users/<str:user_id>/applications/', views.user_applications, name='user_applications'),
    path('api/users/<str:user_id>/conversations/', views.user_conversations, name='user_conversations'),
    path('api/users/<str:user_id>/suspend/', views.suspend_user, name='suspend_user'),
    path('api/users/<str:user_id>/', views.delete_user, name='delete_user'),

    # Jobs
    path('api/jobs/', views.jobs_collection, name='jobs_collection'),
    path('api/jobs/<str:job_id>/', views.job_detail, name='job_detail'),
    path('api/jobs/<str:job_id>/like/', views.job_like, name='job_like'),
    path('api/jobs/<str:job_id>/save/', views.job_save, name='job_save'),
    path('api/jobs/<str:job_id>/apply/', views.job_apply, name='job_apply'),
    path('api/jobs/<str:job_id>/comments/', views.job_comments, name='job_comments'),

    # Chat
    path('api/chats/<str:recruiter_id>/<str:seeker_id>/messages/', views.chat_messages, name='chat_messages'),
    path('api/chats/<str:recruiter_id>/<str:seeker_id>/read/', views.chat_mark_read, name='chat_mark_read'),
    path('api/chats/<str:recruiter_id>/<str:seeker_id>/', views.chat_delete, name='chat_delete'),
]
