import urllib.request, json

for path in ['/health', '/api/ai/status']:
    url = 'http://127.0.0.1:8000' + path
    try:
        r = urllib.request.urlopen(url, timeout=10).read().decode()
        print(path, r)
    except Exception as e:
        print(path, 'ERROR', e)
