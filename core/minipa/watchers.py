"""Read-only arXiv RSS/Atom input, with OJJIPA's existing hash deduplication."""
import html
import json
import re
import time
from threading import Lock
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

from core.attention.dedup import fingerprint
from repos.seen_items import SeenItemsRepository
from core.grandpa.watch_policy import validate_category

_cache = {}
_cache_lock = Lock()


def read_feed(url):
    with _cache_lock:
        cached = _cache.get(url)
        if cached and time.monotonic() - cached[0] < 900:
            return cached[1]
        request = Request(url, headers={'User-Agent':'OJJIPA/0.1 (personal research watcher)'})
        with urlopen(request, timeout=25) as response:
            destination = urlparse(response.geturl())
            if destination.scheme != 'https' or destination.hostname not in ('rss.arxiv.org','export.arxiv.org','arxiv.org'):
                raise ValueError('Unexpected arXiv feed redirect')
            document = response.read(2 * 1024 * 1024 + 1)
        if len(document) > 2 * 1024 * 1024 or b'<!DOCTYPE' in document.upper():
            raise ValueError('Invalid or oversized arXiv feed')
        if len(_cache) >= 64:
            _cache.pop(next(iter(_cache)))
        _cache[url] = (time.monotonic(),document)
        return document


def fetch_items(db, minipa):
    config = json.loads(minipa.config)
    category = validate_category(config.get('arxiv_category', 'cs.AI'))
    url = 'https://rss.arxiv.org/rss/' + category
    if config.get('delivery_mode') == 'papers':
        words = re.findall(r'[\w-]+',config.get('search_terms',''))[:12]
        query = 'cat:' + category
        if words:
            query += ' AND (' + ' AND '.join('all:' + word for word in words) + ')'
        url = 'https://export.arxiv.org/api/query?' + urlencode({'search_query':query,'start':0,'max_results':50,'sortBy':'submittedDate','sortOrder':'descending'})
    document = read_feed(url)
    root = ET.fromstring(document)
    candidates = [node for node in root.iter() if node.tag.split('}')[-1] in ('item','entry')]
    scope = json.dumps([minipa.id, url], separators=(',',':'))
    seen = SeenItemsRepository(db)
    results = []
    for node in candidates[:50]:
        fields = {}
        for child in node:
            name = child.tag.split('}')[-1]
            if name == 'link' and child.attrib.get('rel') not in (None,'alternate'):
                continue
            fields[name] = child.attrib.get('href') or ''.join(child.itertext()).strip()
        identity = fields.get('guid') or fields.get('id') or fields.get('link')
        if not identity:
            continue
        paper_link = fields.get('link') or identity
        parsed_link = urlparse(paper_link)
        if parsed_link.hostname not in ('arxiv.org','export.arxiv.org') or not parsed_link.path.startswith('/abs/'):
            continue
        key = fingerprint(scope, identity)
        if seen.contains(scope, key):
            continue
        results.append({'scope':scope,'key':key,'title':fields.get('title',''),
                        'link':paper_link,
                        'summary': re.sub('<[^>]+>', '', html.unescape(fields.get('description') or fields.get('summary','')))[:4000]})
    return results
