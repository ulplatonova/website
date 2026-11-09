import sys,json
sys.path.insert(0,'../services')
import importlib.util,os
os.chdir('../services');spec=importlib.util.spec_from_file_location('b','build.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);os.chdir('../vk')
T=open('template.html',encoding='utf8').read()
pos=json.load(open('pos.json')) if os.path.exists('pos.json') else {}
names=[]
for k,t,b,r,p,u,ps in m.items:
    ph=(f'<div class="price"><span>от</span><b>{p}</b><span>{u}</span></div>' if p else '<div class="price ask"><b>Цена по запросу<br>у менеджера</b></div>')
    h=28 if len(t)>26 else (32 if len(t)>16 else 36)
    s=(T.replace('{{TITLE}}',t).replace('{{BOLD}}',b).replace('{{REST}}',r).replace('{{PRICEHTML}}',ph).replace('{{H1}}',str(h))
       .replace('{{PHOTO}}',f'../services/photos/{m.photo[k]}.jpg').replace('{{POS}}',pos.get(k,ps)).replace('{{NAME}}',k))
    open(f'{k}.html','w',encoding='utf8').write(s);names.append(k)
json.dump(names,open('names.json','w'))
