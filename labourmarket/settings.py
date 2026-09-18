"""
Django settings for labourmarket project.
"""

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# SECURITY WARNING: keep the secret key used in production secret!
SECRET_KEY = 'django-insecure-gf5x3jp(nv20w#c7x-u&@b#xlgf)f8^2jco_=wj0_&=xfd=s7n'

# SECURITY WARNING: don't run with debug turned on in production!
DEBUG = True

# '*' keeps this working no matter what hostname/IP/domain the site is
# reached through (localhost during development, your LAN IP, or a real
# domain once you make the site reachable from the internet through your
# PC - e.g. via router port-forwarding or a dynamic-DNS/tunnel service).
# If you later turn DEBUG off, replace this with the exact hostnames you
# use, e.g. ['yourlabourmarket.example.com', '203.0.113.5'].
ALLOWED_HOSTS = ['*']

# If/when you serve the site over HTTPS through a real domain, add that
# origin here (scheme + host, no path) so POST/PATCH/DELETE requests from
# the frontend aren't blocked by Django's CSRF-origin check, e.g.:
# CSRF_TRUSTED_ORIGINS = ['https://yourlabourmarket.example.com']
CSRF_TRUSTED_ORIGINS = []


# Application definition

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'core',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'labourmarket.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'labourmarket.wsgi.application'


# Database
# https://docs.djangoproject.com/en/6.1/ref/settings/#databases
#
# This points at PostgreSQL running on THIS machine. It is intentionally
# left untouched - the project keeps using your local Postgres install,
# never an external/hosted database service.
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': 'yourlabourmarket',
        'USER': 'postgres',
        'PASSWORD': 'fidelis',
        'HOST': 'localhost',
        'PORT': '5432',
    }
}

# Password validation
AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]


# Internationalization
LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'Africa/Lagos'
USE_I18N = True
USE_TZ = True


# Static files (CSS, JavaScript, Images)
STATIC_URL = 'static/'

# The plain-HTML frontend (index.html / home.html / admin.html) that Django
# serves directly, and the local image assets those pages reference
# ("images/..."). See labourmarket/urls.py and core/views_frontend.py.
FRONTEND_DIR = BASE_DIR / 'frontend'
STATICFILES_DIRS = [FRONTEND_DIR / 'images']

AUTH_USER_MODEL = 'core.User'

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# Photos are compressed client-side before upload (typically well under
# 500KB), but video/document attachments are allowed up to 8MB (also
# capped client-side) - this gives comfortable headroom above that for
# the JSON/base64 overhead, without exposing an unbounded limit.
DATA_UPLOAD_MAX_MEMORY_SIZE = 15 * 1024 * 1024  # 15 MB
