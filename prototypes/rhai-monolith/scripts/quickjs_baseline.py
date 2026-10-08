#!/usr/bin/env python3
"""Optional isolated QuickJS worker-only comparison. No database, account or network."""
import argparse,json,pathlib,platform,statistics,subprocess,tempfile,time
parser=argparse.ArgumentParser();parser.add_argument('binary');parser.add_argument('--iterations',type=int,default=30);args=parser.parse_args()
binary=str(pathlib.Path(args.binary).resolve())
if platform.system()=='Darwin':
    profile='(version 1)(deny default)(allow process-exec (literal (param "EXEC")))(allow sysctl-read)(allow file-read-metadata)(allow file-read* (literal (param "EXEC")) (subpath "/System/Library") (subpath "/usr/lib") (literal "/dev/urandom") (literal "/dev/random") (literal "/") (regex #"^/opt/homebrew/.*\\.dylib$") (regex #"^/usr/local/.*\\.dylib$"))'
    command=['/usr/bin/sandbox-exec','-D',f'EXEC={binary}','-p',profile,binary,'--worker']
elif platform.system()=='Linux':
    command=['bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--ro-bind','/usr/lib','/usr/lib','--symlink','usr/lib','/lib','--ro-bind-try','/usr/lib64','/usr/lib64','--symlink','usr/lib64','/lib64','--ro-bind',binary,'/worker','--dev','/dev','--tmpfs','/tmp','--chdir','/tmp','/worker','--worker']
else:raise SystemExit('Requires macOS or Linux isolation')
request={'source':"const actions={list:{readOnly:true,run:(_,c)=>c.db.list()}};",'mode':'call','budget_ms':2000,'action':'list','input':{},'records':{},'now':'synthetic','catalog':[],'mock_http':[]}
samples=[]
for _ in range(args.iterations):
    start=time.perf_counter_ns()
    result=subprocess.run(command,input=json.dumps(request)+'\n',text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=3,check=True,env={},cwd=tempfile.gettempdir())
    assert json.loads(result.stdout)['result']==[]
    samples.append((time.perf_counter_ns()-start)//1000)
samples.sort()
print(json.dumps({'scenario':'isolated QuickJS worker-only empty read, includes process/sandbox startup, excludes parent schema/storage work','iterations':len(samples),'medianUs':statistics.median(samples),'p95Us':samples[len(samples)*95//100],'binaryBytes':pathlib.Path(binary).stat().st_size,'comparisonCaveat':'Different implementations and work measured; not a language-only speed comparison'}))
