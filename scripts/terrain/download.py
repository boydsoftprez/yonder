#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Download pinned USGS source files and optional datum grids into an explicit task cache."""
import argparse, hashlib, json, pathlib, urllib.parse, urllib.request
from vertical import GRIDS
ALLOWED={'prd-tnm.s3.amazonaws.com','rockyweb.usgs.gov','cdn.proj.org'}
def store_checked(stream,path,expected_bytes,expected_hash):
    if expected_bytes<=0 or expected_bytes>400*1024*1024:raise ValueError('Source byte limit')
    part=path.with_name(path.name+'.part');total=0;digest=hashlib.sha256()
    try:
        with part.open('wb') as out:
            for block in iter(lambda:stream.read(1024*1024),b''):
                total+=len(block)
                if total>expected_bytes:raise ValueError('Source exceeds expected size')
                out.write(block);digest.update(block)
        if total!=expected_bytes or digest.hexdigest()!=expected_hash:raise ValueError('Source size or checksum changed')
        part.replace(path)
    finally:
        if part.exists():part.unlink()
class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        parsed=urllib.parse.urlparse(newurl)
        if parsed.scheme!='https' or parsed.hostname not in ALLOWED:raise ValueError('Unexpected download redirect')
        return super().redirect_request(req,fp,code,msg,headers,newurl)
def download(info,path):
    url=urllib.parse.urlparse(info['url'])
    if url.scheme!='https' or url.hostname not in ALLOWED:raise ValueError('Unexpected source origin')
    if path.exists():
        if path.stat().st_size==info['bytes']:
            digest=hashlib.sha256()
            with path.open('rb') as existing:
                for block in iter(lambda:existing.read(1024*1024),b''):digest.update(block)
            if digest.hexdigest()==info['sha256']:print('Verified cached',path.name);return
        raise ValueError('Existing cached file changed; inspect it before replacing: '+path.name)
    path.parent.mkdir(parents=True,exist_ok=True)
    with urllib.request.build_opener(Redirect()).open(info['url'],timeout=60) as response:
        store_checked(response,path,info['bytes'],info['sha256'])
    print('Downloaded and verified',path.name)
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache',required=True);parser.add_argument('--sources',default='scripts/terrain/cove-sources.json');parser.add_argument('--grids',action='store_true')
    args=parser.parse_args();root=pathlib.Path(args.cache)
    for source in json.loads(pathlib.Path(args.sources).read_text())['sources']:
        if pathlib.Path(source['file']).name!=source['file']:raise ValueError('Unsafe source name')
        download(source,root/'sources'/source['file'])
    if args.grids:
        for name,info in GRIDS.items():download(info,root/'grids'/name)
if __name__=='__main__':main()
