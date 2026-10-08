#!/usr/bin/env python3
"""Run the real Rust server with synthetic data/providers. Requires Python stdlib only."""
import argparse, concurrent.futures, json, pathlib, subprocess, tempfile, time, threading, queue, urllib.request, urllib.error
parser=argparse.ArgumentParser()
parser.add_argument('--binary',default='target/release/littlespaces-rhai-prototype')
parser.add_argument('--report',default='reports/smoke.json')
args=parser.parse_args()
child=subprocess.Popen([str(pathlib.Path(args.binary).resolve())],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
report={'synthetic':True,'checks':[]}
database=None
try:
    startup=queue.Queue()
    def read_startup():startup.put((child.stdout.readline(),child.stdout.readline()))
    threading.Thread(target=read_startup,daemon=True).start()
    first_line,second_line=startup.get(timeout=5)
    origin=first_line.strip().removeprefix('Rhai prototype: ')
    if not origin.startswith('http://127.0.0.1:'): raise RuntimeError('Prototype did not start on IPv4 loopback')
    database=pathlib.Path(second_line.strip().removeprefix('Synthetic-only; temporary database: '))
    def api(path,body=None,origin_header=None):
        data=None if body is None else json.dumps(body).encode()
        headers={'content-type':'application/json'}
        if origin_header:headers['origin']=origin_header
        request=urllib.request.Request(origin+path,data=data,headers=headers)
        try:
            with urllib.request.urlopen(request,timeout=4) as response:return response.status,json.load(response)
        except urllib.error.HTTPError as error:return error.code,json.load(error)
    def call(app,action,input={},**extra):return api(f'/api/apps/{app}/actions/{action}',{'input':input,'version':1,**extra})
    report['startupRssKiB']=int(subprocess.check_output(['ps','-o','rss=','-p',str(child.pid)],text=True))
    assert api('/health')[1]['node'] is False
    assert api('/health')[1]['codex'] is False
    status,added=call('tasks','add',{'title':'Walk the dog'});assert status==200
    key=added['result']['key']
    assert call('tasks','complete',{'key':key})[1]['result']['done'] is True
    assert call('journal','list')[1]['result']==[]
    before=call('tasks','list')[1]['result']
    assert call('tasks','add',{'title':'Dry run'},dry_run=True)[0]==200
    assert call('tasks','list')[1]['result']==before
    assert call('tasks','add',{})[0]==400
    assert call('tasks','add',{'title':'stale'},version=99)[0]==400
    assert call('weather','weather')[1]['result']['temperatureC']==18.5
    assert api('/api/apps/tasks/actions/add',{'input':{'title':'foreign'},'version':1},'https://foreign.example')[0]==403
    status,ai=api('/api/ai',{'message':'Created by synthetic AI'});assert status==200
    assert len(ai['tools'])==1 and ai['tools'][0]['result']['committed'] is True
    assert len(call('tasks','list')[1]['result'])==2
    barrier=threading.Barrier(5)
    def hold(_):
        barrier.wait(timeout=2)
        request=urllib.request.Request(origin+'/api/lab/hold',data=b'{}',headers={'content-type':'application/json'})
        try:
            with urllib.request.urlopen(request,timeout=4) as response:return response.status
        except urllib.error.HTTPError as error:return error.code
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:statuses=list(pool.map(hold,range(5)))
    assert statuses.count(200)==4 and statuses.count(503)==1,statuses
    assert api('/health')[0]==200
    report['afterWorkloadRssKiB']=int(subprocess.check_output(['ps','-o','rss=','-p',str(child.pid)],text=True))
    # A deployed server process has no worker, Node, or Codex child processes.
    rows=subprocess.check_output(['ps','-eo','pid,ppid,comm'],text=True).splitlines()[1:]
    children=[line for line in rows if len(line.split())>=3 and line.split()[1]==str(child.pid)]
    assert children==[],children
    report['checks']=['task create/complete','app scope','dry run','schema errors','stale revision','HTTP weather fixture','origin rejection','Rust AI tool loop','concurrent reads/admission','no child processes']
    report['concurrentStatuses']=statuses
    report['passed']=True
    print(json.dumps(report,indent=2))
finally:
    child.terminate()
    try:child.wait(timeout=3)
    except subprocess.TimeoutExpired:child.kill();child.wait(timeout=3)
    if database and database.name.startswith('rhai-prototype-') and database.parent.resolve()==pathlib.Path(tempfile.gettempdir()).resolve():
        for suffix in ['', '-journal','-wal','-shm']:
            pathlib.Path(str(database)+suffix).unlink(missing_ok=True)
    report_path=pathlib.Path(args.report);report_path.parent.mkdir(parents=True,exist_ok=True)
    report_path.write_text(json.dumps(report,indent=2)+'\n')
