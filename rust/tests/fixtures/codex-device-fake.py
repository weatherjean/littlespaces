#!/usr/bin/env python3
"""Synthetic JSON-RPC peer; never connects to a real provider."""
import json, os, sys, time
from pathlib import Path
home = Path(os.environ['CODEX_HOME'])
def send(value):
    print(json.dumps(value), flush=True)
def result(i, value):
    send({'id':i,'result':value})
for line in sys.stdin:
    m=json.loads(line); method=m.get('method'); i=m.get('id'); p=m.get('params',{})
    if not method: continue
    if method=='initialize':
        assert p['capabilities']['experimentalApi']
        assert 'OPENAI_API_KEY' not in os.environ
        result(i,{})
    elif method=='initialized': pass
    elif method=='account/login/start':
        assert p['type']=='chatgptDeviceCode'
        (home/'pending').write_text('yes')
        result(i,{'type':'chatgptDeviceCode','loginId':'login-test','userCode':'TEST-1234','verificationUrl':'https://auth.openai.com/codex/device'})
    elif method=='account/read':
        if (home/'approve').exists() and (home/'pending').exists():
            (home/'pending').unlink(); (home/'approve').unlink()
            (home/'auth.json').write_text('{"synthetic":true}')
            send({'method':'account/login/completed','params':{'loginId':'login-test','success':True}})
        result(i,{'account':{'type':'chatgpt','email':'synthetic@example.test'} if (home/'auth.json').exists() else None})
    elif method=='account/login/cancel':
        (home/'pending').unlink(missing_ok=True); result(i,{})
    elif method=='account/logout':
        (home/'pending').unlink(missing_ok=True); (home/'auth.json').unlink(missing_ok=True); result(i,{})
    elif method=='model/list':
        result(i,{'data':[{'model':'synthetic','displayName':'Synthetic','supportedReasoningEfforts':[{'reasoningEffort':'low'}]}],'nextCursor':None})
    elif method=='thread/start':
        assert p['environments']==[] and p['approvalPolicy']=='never' and p['sandbox']=='read-only' and p['ephemeral']
        assert p['dynamicTools'][0]['inputSchema']=={'type':'object'}
        result(i,{'thread':{'id':'thread-test'}})
    elif method=='thread/inject_items':
        assert p['items'][0]['role']=='user'
        result(i,{})
    elif method=='turn/start':
        scenario=(home/'scenario').read_text() if (home/'scenario').exists() else 'complete'
        # Events can legally precede the response to turn/start.
        send({'method':'item/agentMessage/delta','params':{'threadId':'thread-test','delta':'Hello'}})
        result(i,{'turn':{'id':'turn-test'}})
        if scenario=='crash': sys.exit(0)
        if scenario=='wait': time.sleep(60)
        elif scenario=='tool': send({'id':'server-tool-1','method':'item/tool/call','params':{'threadId':'thread-test','tool':'read_sdk','callId':'call-1','arguments':{}}})
        elif scenario=='unknown': send({'id':'server-tool-1','method':'item/tool/call','params':{'threadId':'thread-test','tool':'exec_command','callId':'call-1','arguments':{}}})
        else:
            send({'method':'item/completed','params':{'threadId':'thread-test','item':{'type':'agentMessage','text':'Hello'}}})
            send({'method':'turn/completed','params':{'threadId':'thread-test','turn':{'id':'turn-test','status':'failed' if scenario=='failed' else 'completed'}}})
    elif method=='turn/interrupt': result(i,{})
    else: send({'id':i,'error':{'code':-32601,'message':'unknown'}})
