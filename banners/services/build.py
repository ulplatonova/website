import json
items=[
 ("general","Генеральная уборка квартир и домов","Глубокая уборка","всех труднодоступных мест и помещений","8.490","руб.","30% 40%"),
 ("repair","Уборка после ремонта квартир и домов","Полное удаление","строительной пыли, грязи и остатков материалов","11.990","руб.","50% 50%"),
 ("support","Поддерживающая уборка квартир и домов","Регулярное поддержание","чистоты и свежести без потери качества","4.990","руб.","40% 40%"),
 ("drycleaning","Химчистка","Деликатное очищение","мягкой мебели и штор","800","руб.","50% 50%"),
 ("windows","Мойка окон","Безупречная чистота","стекол, подоконников, рам без разводов","550","руб./створка","50% 50%"),
]
photo={"general":"general","repair":"repair","support":"support","drycleaning":"dry","windows":"window"}
T=open('template.html',encoding='utf8').read()
for k,t,b,r,p,u,pos in items:
    h=(T.replace('{{TITLE}}',t).replace('{{BOLD}}',b).replace('{{REST}}',r).replace('{{PRICE}}',p)
        .replace('{{UNIT}}',u).replace('{{PHOTO}}',f'photos/{photo[k]}.jpg').replace('{{POS}}',pos).replace('{{NAME}}',k))
    open(f'{k}.html','w',encoding='utf8').write(h)
json.dump([i[0] for i in items],open('names.json','w'))
