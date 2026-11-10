// クラウドからAmazonの発売日順検索が見えているかを調べる診断用スクリプト
import { chromium } from 'playwright';
const base='https://www.amazon.co.jp/s?i=stripbooks&rh=n%3A465392%2Cn%3A466280%2Cn%3A2278488051&s=date-desc-rank';
const b=await chromium.launch({args:['--no-sandbox','--disable-blink-features=AutomationControlled']});
const ctx=await b.newContext({locale:'ja-JP',timezoneId:'Asia/Tokyo',
  userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/'+(b.version()||'140').split('.')[0]+'.0.0.0 Safari/537.36'});
const p=await ctx.newPage();
const res=await p.goto(base+'&page=1',{waitUntil:'domcontentloaded',timeout:30000}).catch(e=>({status:()=>'ERR:'+e.message}));
await p.waitForTimeout(3000);
console.log('HTTPステータス:', typeof res.status==='function'?res.status():'?');
console.log('URL:', p.url());
const title=await p.title().catch(()=>'');
console.log('ページタイトル:', title);
const body=(await p.evaluate(()=>document.body.innerText||'')).replace(/\s+/g,' ').slice(0,300);
console.log('本文冒頭:', body);
const asins=await p.$$eval('div[data-asin]',els=>els.filter(e=>(e.getAttribute('data-asin')||'').length===10).length).catch(()=>0);
console.log('商品カード数:', asins);
const captcha=/captcha|ロボットではありません|Enter the characters|自動化/i.test(body+title);
console.log('CAPTCHA/ボット判定らしき表示:', captcha?'あり':'なし');
await b.close();
