#!/usr/bin/env python3
"""Run all Java regression tests against the built archive (never source classes or stubs)."""
import argparse, os, pathlib, subprocess, tempfile
p=argparse.ArgumentParser();p.add_argument('jar');p.add_argument('--java-bin',required=True);p.add_argument('--api-dir',required=True);p.add_argument('--tests',nargs='*')
a=p.parse_args();root=pathlib.Path(__file__).resolve().parent
names=a.tests or sorted(x.stem for x in (root/'test').glob('*Test.java'))
cp=os.pathsep.join([str(pathlib.Path(a.jar).resolve())]+[str(x) for x in pathlib.Path(a.api_dir).rglob('*.jar')])
with tempfile.TemporaryDirectory(prefix='nautilus-tests-') as temp:
 sources=[str(root/'test'/f'{name}.java') for name in names]+[str(x) for x in (root/'test'/'support').glob('*.java')]
 if any(name.endswith('ReadinessTest') for name in names):sources += [str(x) for x in (root/'test'/'readiness').glob('*.java')]
 subprocess.run([a.java_bin+'/javac','-encoding','UTF-8','--release','21','-cp',cp,'-d',temp]+sources,check=True)
 failed=[]
 for name in names:
  print(f'== {name}',flush=True)
  result=subprocess.run([a.java_bin+'/java','-Dstdout.encoding=UTF-8','-Dstderr.encoding=UTF-8','-cp',temp+os.pathsep+cp,name])
  if result.returncode:failed.append(name)
 if failed:raise SystemExit('FAILED: '+', '.join(failed))
 print(f'All Java tests passed ({len(names)}).')
