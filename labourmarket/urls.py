from django.contrib import admin
from django.urls import path, include, re_path
from django.views.static import serve as static_serve

from core.views_frontend import serve_frontend_page
from django.conf import settings

urlpatterns = [
    path('admin/', admin.site.urls),
    path('', include('core.urls')),

    # The plain image assets the frontend pages reference as "images/...".
    # Served directly at /images/ (not under STATIC_URL) so the existing
    # relative paths in index.html/home.html/admin.html keep working
    # unchanged.
    re_path(r'^images/(?P<path>.*)$', static_serve, {'document_root': settings.FRONTEND_DIR / 'images'}),

    # The React-free frontend (index.html / home.html / admin.html) is
    # served directly by Django so the whole site runs from one origin
    # ("python manage.py runserver") with no separate Node server and no
    # CORS setup needed.
    path('', serve_frontend_page, {'page': 'index.html'}, name='home_page'),
    path('index.html', serve_frontend_page, {'page': 'index.html'}, name='index_page'),
    path('home.html', serve_frontend_page, {'page': 'home.html'}, name='home_html_page'),
    path('admin.html', serve_frontend_page, {'page': 'admin.html'}, name='admin_html_page'),
]

