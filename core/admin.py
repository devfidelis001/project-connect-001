from django.contrib import admin
from .models import User, Job, JobLike, JobSave, JobApplication, JobComment, ChatMessage

admin.site.register(User)
admin.site.register(Job)
admin.site.register(JobLike)
admin.site.register(JobSave)
admin.site.register(JobApplication)
admin.site.register(JobComment)
admin.site.register(ChatMessage)
