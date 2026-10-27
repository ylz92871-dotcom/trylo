def fetch(url, head=False):
    # Use the server's standard curl client. Cloudflare rejects the default
    # Python urllib user agent (403); no zone rule or protection is changed.
    with tempfile.TemporaryDirectory(prefix='trylo-public-') as directory:
        body = pathlib.Path(directory) / 'body'
        headers_file = pathlib.Path(directory) / 'headers'
        command = ['curl', '-sS', '-L', '--max-redirs', '3', '--max-time', '25',
                   '-D', str(headers_file), '-o', str(body),
                   '-w', '%{http_code}\n%{url_effective}', url]
        if head:
            command.insert(1, '-I')
        result = subprocess.run(command, check=True, capture_output=True, text=True)
        status, final = result.stdout.split('\n', 1)
        blocks = headers_file.read_text().strip().split('\n\n')
        headers = {}
        for line in blocks[-1].splitlines()[1:]:
            if ':' in line:
                name, value = line.split(':', 1)
                headers[name.lower()] = value.strip()
        return int(status), final, headers, body.read_bytes()

def unmask_email(data):
    # Accept only the observed Cloudflare email rewrite, then demand the exact
    # original SHA256. Any unrelated HTML change still fails verification.
    def decode(value):
        encoded = bytes.fromhex(value)
        return bytes(byte ^ encoded[0] for byte in encoded[1:]).decode('utf-8')
    html = data.decode('utf-8')
    html = re.sub(r'href="/cdn-cgi/l/email-protection#([a-f0-9]+)"',
                  lambda match: 'href="mailto:' + decode(match[1]) + '"', html)
    html = re.sub(r'<span class="__cf_email__" data-cfemail="([a-f0-9]+)">\[email&#160;protected\]</span>',
                  lambda match: decode(match[1]), html)
    html = html.replace('<script data-cfasync="false" src="/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js"></script>', '')
    return html.encode('utf-8')
