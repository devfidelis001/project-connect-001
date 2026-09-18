import os

from django.conf import settings
from django.http import HttpResponse, Http404

# Only these exact filenames may be served - this is a small fixed
# whitelist, not a general-purpose file server.
ALLOWED_PAGES = {'index.html', 'home.html', 'admin.html'}


def serve_frontend_page(request, page):
    if page not in ALLOWED_PAGES:
        raise Http404()
    path = os.path.join(settings.FRONTEND_DIR, page)
    if not os.path.isfile(path):
        raise Http404()
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    return HttpResponse(content, content_type='text/html; charset=utf-8')
