"""Run production helper main with fake native APIs; never invokes Win32."""
import ctypes,threading,runpy,sys,io,json,contextlib
source,case=sys.argv[1:];owner=4242;staged=[];committed=[];calls=[]
class Fn:
 def __init__(self,name):self.name=name
 def __call__(self,*args):
  n=self.name;calls.append((n,args))
  if n=='OpenProcess':return 99
  if n=='WaitForSingleObject':return 0 if case=='owner-dead' else 258
  if n in ['SetThreadDpiAwarenessContext','CloseHandle']:return 1
  if n=='GetWindowThreadProcessId':args[1]._obj.value=owner+(1 if case=='foreign' and args[0]==2 else 0);return 1
  if n=='IsWindowVisible':return 0 if case=='hidden' and args[0]==2 else 1
  if n=='BeginDeferWindowPos':return 10
  if n=='DeferWindowPos':
   if case=='second-failure' and args[1]==2:return 0
   staged.append(args[1:]);return 10
  if n=='EndDeferWindowPos':
   if case=='end-failure':return 0
   committed.extend(staged);return 1
  if n=='SetWindowPos':
   if case=='second-failure' and args[0]==2:return 0
   committed.append(args);return 1
  raise AssertionError(n)
class DLL:
 def __init__(self):self.functions={}
 def __getattr__(self,n):return self.functions.setdefault(n,Fn(n))
class Thread:
 def __init__(self,*a,**kw):pass
 def start(self):pass
 def join(self,*a):pass
ctypes.WinDLL=lambda *a,**kw:DLL();threading.Thread=Thread
ns=runpy.run_path(source,run_name='qa_fake_win32');sys.argv=[source,str(owner)];sys.stdin=io.StringIO(json.dumps({'id':1,'type':'move','targets':[{'handle':'1','x':20,'y':30},{'handle':'2','x':40,'y':50}]})+'\n');output=io.StringIO()
with contextlib.redirect_stdout(output):ns['main']()
messages=[json.loads(x) for x in output.getvalue().splitlines()];result=messages[-1];names=[x[0] for x in calls]
if case=='success':
 assert result['ok'] and len(committed)==2,(result,committed)
 assert names.count('BeginDeferWindowPos')==names.count('EndDeferWindowPos')==1,names
 assert 'SetWindowPos' not in names,names
 assert all(args[-1]&0x15==0x15 for name,args in calls if name=='DeferWindowPos')
else:
 assert result['ok'] is False,result
 assert not committed,committed
 if case in ['owner-dead','foreign','hidden']:assert 'BeginDeferWindowPos' not in names and 'SetWindowPos' not in names,names
print(json.dumps({'case':case,'passed':True,'kind':'fake Win32 execution of production Python handler'}))
