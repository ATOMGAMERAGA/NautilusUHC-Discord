#!/usr/bin/env python3
"""Patch the supplied archive; compile against actual server API libraries, never package them."""
import argparse, pathlib, subprocess, tempfile, zipfile, re, hashlib
p=argparse.ArgumentParser();p.add_argument('input');p.add_argument('output');p.add_argument('--java-bin',required=True);p.add_argument('--api-dir',required=True);p.add_argument('--version',default='1.2.10')
a=p.parse_args();root=pathlib.Path(__file__).resolve().parent
sources=[x for x in (root/'src').rglob('*.java') if x.name!='BridgeInstance.java']
with tempfile.TemporaryDirectory(prefix='nautilus-build-') as tmp:
 cp=':'.join([a.input]+[str(x) for x in pathlib.Path(a.api_dir).rglob('*.jar')])
 subprocess.run([a.java_bin+'/javac','-encoding','UTF-8','--release','21','-cp',cp,'-d',tmp]+[str(x) for x in sources],check=True)
 classes={str(x.relative_to(tmp)):x.read_bytes() for x in pathlib.Path(tmp).rglob('*.class')}
 prefixes=[str(x.relative_to(root/'src')).removesuffix('.java') for x in sources]
 def replaced(n):return any(n==x+'.class' or n.startswith(x+'$') for x in prefixes)
 pathlib.Path(a.output).parent.mkdir(parents=True,exist_ok=True)
 with zipfile.ZipFile(a.input) as base,zipfile.ZipFile(a.output,'w',zipfile.ZIP_DEFLATED) as out:
  for entry in base.infolist():
   n=entry.filename
   if replaced(n):continue
   data=base.read(n)
   if n=='plugin.yml':
    text=data.decode();text=re.sub(r'(?m)^version:.*$','version: '+a.version,text)
    if not re.search(r'(?m)^  teamadmin:',text):text=text.replace('commands:\n','commands:\n  teamadmin:\n    description: Takımları yönetim panelinden düzenler\n    usage: /teamadmin\n    permission: nautilus.host\n\n',1)
    data=text.encode()
   if n=='config.yml':data=re.sub(rb'(?m)^(\s*token:\s*).+$',rb'\1""',data)
   out.writestr(entry,data)
  for n,data in classes.items():out.writestr(n,data)
 with zipfile.ZipFile(a.input) as base,zipfile.ZipFile(a.output) as out:
  assert out.testzip() is None
  unchanged=[n for n in base.namelist() if not replaced(n) and n not in ('plugin.yml','config.yml')]
  for n in unchanged:assert base.read(n)==out.read(n),n
  assert all(n.startswith('com/nautilus/') for n in classes)
  print(f'{len(classes)} patched classes; {len(unchanged)} entries preserved byte-for-byte')
 print(hashlib.sha256(pathlib.Path(a.output).read_bytes()).hexdigest(),a.output)
