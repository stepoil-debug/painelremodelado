
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as pdfjsLib from "npm:pdfjs-dist@4.10.38/legacy/build/pdf.mjs";

const SHEET_ID = 2580648465590148;
const API = "https://api.smartsheet.com/2.0";

type TextItem={text:string;x:number;y:number;w:number;h:number};
type TextLine={y:number;text:string;items:TextItem[]};
type PdfPage={page:number;width:number;height:number;lines:TextLine[];items:TextItem[]};
type MaterialRow={
  row_index:number;spool_raw?:string|null;material_code?:string|null;description:string;
  material_grade?:string|null;unit?:string|null;quantity?:number|null;weight_kg?:number|null;
  heat_number?:string|null;certificate?:string|null;size?:string|null;schedule?:string|null;
  page:number;raw_payload:Record<string,unknown>;
};

function json(body:unknown,status=200){
  return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
}
function clean(v:unknown){const s=String(v??"").trim();return s||null}
function projectCore(v:unknown){
  let s=String(v??"").toUpperCase().trim().replace(/^(BSP|BEP|BPP|B3D|SP)[\s_-]*/,"");
  const m=s.match(/(\d{2}-\d+(?:-\d+)?)/);return m?m[1]:s;
}
function parseNum(v:unknown):number|null{
  let s=String(v??"").trim().replace(/\s/g,"");
  if(!s||s==="-"||/^N\.?A\.?$/i.test(s))return null;
  s=s.replace(/[^0-9,.-]/g,"");if(!s)return null;
  if(s.includes(",")&&s.includes(".")){
    if(s.lastIndexOf(",")>s.lastIndexOf("."))s=s.replace(/\./g,"").replace(",",".");
    else s=s.replace(/,/g,"");
  }else if(s.includes(","))s=s.replace(",",".");
  const n=Number(s);return Number.isFinite(n)?n:null;
}
function unique(xs:(string|null|undefined)[]){return [...new Set(xs.map(x=>String(x||"").trim()).filter(Boolean))]}
function sourceBase(source:any){
  return String(source.drawing_number||source.document_title||"").replace(/\s*\(FCB\)\s*/ig,"").trim();
}
function itemType(source:any){
  const s=(String(source.drawing_number||"")+" "+String(source.document_title||"")).toUpperCase();
  if(/[-\s]SUP[-\s]/.test(s)||s.includes("SUPPORT"))return "SUPPORT";
  if(/[-\s]STR[-\s]/.test(s)||s.includes("STRUCTURE"))return "STRUCTURE";
  if(s.includes("FRAME"))return "FRAME";
  return "SPOOL";
}
function pad3(v:string){const n=Number(v);return Number.isFinite(n)?String(n).padStart(3,"0"):v}
function expandSpool(base:string,raw:string){
  const s=String(raw||"").trim();if(!s)return null;
  if(/^(BSP|BEP|BPP|B3D|SP)-/i.test(s))return s;
  const m=s.match(/(?:SPL|SPOOL)[-_\s]*(\d+)/i);
  if(m)return base.replace(/\s*\(FCB\)\s*/ig,"").replace(/[-\s]+$/,"")+"-SPL-"+pad3(m[1]);
  return base+"-"+s.replace(/\s+/g,"-");
}
function deriveMaterial(desc:string){
  const found:string[]=[];
  const patterns=[
    /ASTM\s+[A-Z]\d+[A-Z0-9.\-]*(?:\s+GR\.?\s*[A-Z0-9.\-]+)?/gi,
    /\bA\d{3}[A-Z0-9.\-]*(?:\s+GR\.?\s*[A-Z0-9.\-]+)?/gi,
    /\bS\d{5}\b/gi,/UNS\s+[A-Z0-9]+/gi
  ];
  for(const p of patterns)for(const m of desc.matchAll(p))found.push(m[0].trim());
  return unique(found).slice(0,10).join(" | ")||desc.slice(0,700);
}
function deriveSize(desc:string){
  const nd=desc.match(/\bND\s*([0-9+./,-]+)\s*["”]?/i);if(nd)return nd[1].replace(",",".")+'"';
  const inch=desc.match(/\b(\d+(?:[+.\/]\d+)?)\s*["”]/);if(inch)return inch[1]+'"';
  const profile=desc.match(/\b(W\d+\s*X\s*[\d,.]+\s*KG\/M)/i);if(profile)return profile[1];
  const plate=desc.match(/\b(\d+\s*X\s*\d+\s*MM)/i);if(plate)return plate[1];
  return null;
}
function deriveSchedule(desc:string){
  const m=desc.match(/\bSCH(?:EDULE)?\s*([A-Z0-9.]+)/i);if(m)return m[1].toUpperCase();
  const x=desc.match(/\b(XXS|XS|STD)\b/i);return x?x[1].toUpperCase():null;
}
function revisionMatchesFile(name:string,rev:string){
  const n=name.toUpperCase().replace(/\s+/g,"");
  const r=rev.toUpperCase().replace(/[^A-Z0-9]/g,"");
  if(!r)return false;
  return n.includes("REV_"+r)||n.includes("REV-"+r)||n.includes("REV."+r)||n.includes("REV"+r)
    ||n.endsWith("="+r+".PDF")||n.endsWith("-"+r+".PDF")||n.endsWith("_"+r+".PDF");
}
function getValueBelow(page:PdfPage,label:RegExp,maxGap=55){
  const hit=page.lines.find(l=>label.test(l.text));if(!hit)return null;
  const rows=page.lines.filter(l=>l.y<hit.y&&hit.y-l.y<=maxGap&&l.text&&!label.test(l.text)).sort((a,b)=>b.y-a.y);
  return rows[0]?.text||null;
}
function parseRevisionTable(page:PdfPage){
  const hit=page.lines.find(l=>/REVISION\s*\|\s*DESCRIPTION/i.test(l.text));if(!hit)return [];
  const rows=page.lines.filter(l=>l.y<hit.y&&hit.y-l.y<120);
  return unique(rows.map(l=>l.text.match(/^\s*([A-Z0-9]+)\s*\|/i)?.[1]?.toUpperCase()));
}
function parseTotals(page:PdfPage){
  const hit=page.lines.find(l=>/Área Total de Pintura|TOTAL PAINTING AREA/i.test(l.text));if(!hit)return {painting:null,weight:null};
  const rows=page.lines.filter(l=>l.y<hit.y&&hit.y-l.y<=20).sort((a,b)=>b.y-a.y);
  for(const l of rows){
    const nums=l.text.split("|").map(parseNum).filter((x):x is number=>x!==null);
    if(nums.length>=2)return {painting:nums[0],weight:nums[nums.length-1]};
  }
  return {painting:null,weight:null};
}
function findHeaders(page:PdfPage){
  const lines=page.lines.filter(l=>/Material description|Descrição do Material/i.test(l.text)&&/Quantity|Quantidade/i.test(l.text)&&/Weight|Peso/i.test(l.text));
  if(!lines.length)return null;
  const y=Math.max(...lines.map(l=>l.y));
  const items=page.lines.filter(l=>Math.abs(l.y-y)<=14).flatMap(l=>l.items);
  const cols:{name:string;x:number}[]=[];
  const pick=(name:string,re:RegExp)=>{const h=items.find(i=>re.test(i.text));if(h)cols.push({name,x:h.x})};
  pick("spool",/Spool|Numero do Spool/i);
  pick("code",/Item Code|Material code|Código|Cod\. Alterdata/i);
  pick("desc",/Material description|Descrição do Material/i);
  pick("unit",/Unit of|Unidade de|medida/i);
  pick("qty",/Quantity|Quantidade/i);
  pick("weight",/Unit Weight|Weight|Peso/i);
  pick("heat",/Heat Number|Corrida/i);
  pick("cert",/Certificate|Certificado/i);
  return {y,cols:[...new Map(cols.map(c=>[c.name,c])).values()].sort((a,b)=>a.x-b.x)};
}
function mapCols(items:TextItem[],cols:{name:string;x:number}[]){
  const out:Record<string,string[]>={};if(!cols.length)return {} as Record<string,string>;
  for(const it of items){
    let best=cols[0],dist=Math.abs(it.x-best.x);
    for(const c of cols){const d=Math.abs(it.x-c.x);if(d<dist){best=c;dist=d}}
    (out[best.name]??=[]).push(it.text);
  }
  return Object.fromEntries(Object.entries(out).map(([k,v])=>[k,v.join(" ").trim()]));
}
function parseMaterialsPage(page:PdfPage,start:number){
  const hasMaterials=page.lines.some(l=>/LIST OF MATERIALS|LISTA DE MATERIAIS/i.test(l.text));
  if(!hasMaterials)return {rows:[] as MaterialRow[],totals:parseTotals(page),identity:null as string|null};
  const body=page.lines
    .map(l=>l.text.trim())
    .filter(Boolean)
    .filter(t=>!/^LIST OF MATERIALS|^LISTA DE MATERIAIS|^DESCRIPTION$|^PAINT AREA|^S\/Q|^TOTAL FAB|^TOTAL WEIGHT|^\d+\s*\|/i.test(t));
  const description=body.join(" ").replace(/\s+/g," ").trim();
  const qtyLine=page.lines.map(l=>l.text).find(t=>/^\s*\d+\s*\|\s*\d+/i.test(t));
  const qty=qtyLine?parseNum(qtyLine.split("|")[1]):1;
  const identity=page.lines.find(l=>/BSP[-\s\d]+-SUP-\d+/i.test(l.text))?.text||null;
  const row:MaterialRow={
    row_index:start,spool_raw:"SUP-"+String(page.page).padStart(3,"0"),material_code:null,
    description,material_grade:deriveMaterial(description),unit:null,quantity:qty||1,weight_kg:null,
    heat_number:null,certificate:null,size:deriveSize(description),schedule:deriveSchedule(description),
    page:page.page,raw_payload:{lines:page.lines.map(l=>l.text)}
  };
  return {rows:description?[row]:[],totals:parseTotals(page),identity};
}
function parseCutPage(page:PdfPage,start:number){
  const h=findHeaders(page);if(!h)return {rows:[] as MaterialRow[],totals:parseTotals(page),identity:null as string|null};
  const mains:{line:TextLine;map:Record<string,string>}[]=[];
  for(const line of page.lines.filter(l=>l.y<h.y-2&&l.y>20)){
    const m=mapCols(line.items,h.cols);
    const qty=parseNum(m.qty),wt=parseNum(m.weight);
    if((clean(m.code)||clean(m.spool))&&(qty!==null||wt!==null))mains.push({line,map:m});
  }
  mains.sort((a,b)=>b.line.y-a.line.y);
  const rows:MaterialRow[]=[];
  for(let i=0;i<mains.length;i++){
    const cur=mains[i],prev=i===0?h.y:mains[i-1].line.y,next=i===mains.length-1?20:mains[i+1].line.y;
    const upper=(prev+cur.line.y)/2,lower=(cur.line.y+next)/2;
    const block=page.lines.filter(l=>l.y<upper&&l.y>lower);
    const desc=unique(block.map(l=>mapCols(l.items,h.cols).desc)).join(" | ");
    rows.push({
      row_index:start+rows.length,spool_raw:clean(cur.map.spool),material_code:clean(cur.map.code),
      description:desc||clean(cur.map.code)||"",material_grade:deriveMaterial(desc||clean(cur.map.code)||""),unit:clean(cur.map.unit),
      quantity:parseNum(cur.map.qty),weight_kg:parseNum(cur.map.weight),heat_number:clean(cur.map.heat),
      certificate:clean(cur.map.cert),size:deriveSize(desc),schedule:deriveSchedule(desc),page:page.page,
      raw_payload:{line:cur.line.text,y:cur.line.y,block:block.map(x=>x.text)}
    });
  }
  const label=page.lines.find(l=>/Numero do desenho/i.test(l.text));
  const after=label?page.lines.filter(l=>l.y<label.y&&label.y-l.y<=14&&l.text).sort((a,b)=>b.y-a.y)[0]:null;
  return {rows,totals:parseTotals(page),identity:after?.text||null};
}
async function extractPdf(bytes:Uint8Array):Promise<PdfPage[]>{
  const doc=await pdfjsLib.getDocument({data:bytes,useSystemFonts:true,disableFontFace:true}).promise;
  const pages:PdfPage[]=[];
  for(let p=1;p<=Math.min(doc.numPages,80);p++){
    const pg=await doc.getPage(p),vp=pg.getViewport({scale:1}),content=await pg.getTextContent();
    const items=(content.items as any[]).map((it:any)=>({
      text:String(it.str||"").trim(),x:Number(it.transform?.[4]||0),y:Number(it.transform?.[5]||0),
      w:Number(it.width||0),h:Number(it.height||0)
    })).filter((x:TextItem)=>x.text);
    items.sort((a:TextItem,b:TextItem)=>Math.abs(b.y-a.y)>2?b.y-a.y:a.x-b.x);
    const lines:TextLine[]=[];
    for(const it of items){
      let l=lines.find(x=>Math.abs(x.y-it.y)<=2);
      if(!l){l={y:it.y,text:"",items:[]};lines.push(l)}l.items.push(it);
    }
    lines.sort((a,b)=>b.y-a.y);
    for(const l of lines){l.items.sort((a,b)=>a.x-b.x);l.text=l.items.map(x=>x.text).join(" | ")}
    pages.push({page:p,width:vp.width,height:vp.height,lines,items});
  }
  return pages;
}
async function sha256(bytes:Uint8Array){
  const d=await crypto.subtle.digest("SHA-256",bytes);return Array.from(new Uint8Array(d)).map(b=>b.toString(16).padStart(2,"0")).join("");
}
async function sheetGet(path:string,token:string){
  const r=await fetch(API+path,{headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"}});
  if(!r.ok)throw new Error("Smartsheet "+path+" => "+r.status+" "+(await r.text()).slice(0,300));
  return r.json();
}
async function attachmentFor(rowId:number,rev:string,token:string){
  const list=await sheetGet(`/sheets/${SHEET_ID}/rows/${rowId}/attachments?includeAll=true&pageSize=100`,token);
  const files=(Array.isArray(list)?list:(list.data||[])).filter((a:any)=>String(a.mimeType||"").toLowerCase()==="application/pdf");
  const ranked=files.map((a:any)=>{
    let score=revisionMatchesFile(String(a.name||""),rev)?100:0;
    if(/BACK|COMENT|VERIF|MARKUP/i.test(String(a.name||"")))score-=40;
    return {...a,_score:score};
  }).sort((a:any,b:any)=>b._score-a._score||new Date(b.createdAt||0).getTime()-new Date(a.createdAt||0).getTime());
  return ranked.find((x:any)=>x._score>=100)||(ranked.length===1?ranked[0]:null);
}
async function parseSource(source:any,project:string,token:string){
  const rev=String(source.current_revision||"").trim().toUpperCase();
  const attachment=await attachmentFor(Number(source.source_row_id),rev,token);
  if(!attachment)return {ok:false,source,error:"FCB vigente sem PDF da revisão "+rev+" anexado na linha."};

  const meta=await sheetGet(`/sheets/${SHEET_ID}/attachments/${attachment.id}`,token);
  if(!meta.url)return {ok:false,source,error:"URL do anexo FCB indisponível."};
  const file=await fetch(String(meta.url));if(!file.ok)return {ok:false,source,error:"Falha ao baixar FCB: "+file.status};
  const bytes=new Uint8Array(await file.arrayBuffer());
  const [fileHash,pages]=await Promise.all([sha256(bytes),extractPdf(bytes)]);
  if(!pages.length)return {ok:false,source,error:"FCB sem texto extraível."};

  const cover=pages[0],revisions=parseRevisionTable(cover);
  const revisionMatched=revisions.includes(rev);
  const projectText=getValueBelow(cover,/Project Number|Número do Projeto/i,45)||"";
  const projectMatched=projectCore(projectText)===projectCore(project);
  const fcbCover=getValueBelow(cover,/Fabrication Control Book|Controle de Fabricação/i,60);
  const lineNumber=getValueBelow(cover,/Line Number|Tag da linha/i,45);
  const reference=getValueBelow(cover,/Reference Document|Documento de referência/i,45);
  const base=sourceBase(source),type=itemType(source);

  const cutPages=pages.filter(p=>p.lines.some(l=>/Cut List and Traceability|Lista de Corte e Registro|LIST OF MATERIALS|LISTA DE MATERIAIS/i.test(l.text)));
  let allRows:MaterialRow[]=[];const pageMeta:any[]=[];let idx=1;
  for(const p of cutPages){
    const parsed=parseCutPage(p,idx);const materialParsed=parsed.rows.length?parsed:parseMaterialsPage(p,idx);const chosen=materialParsed.rows.length?materialParsed:parsed;idx+=chosen.rows.length;allRows=allRows.concat(chosen.rows);
    pageMeta.push({page:p.page,identity:chosen.identity,totals:chosen.totals,row_count:chosen.rows.length});
  }

  const warnings:string[]=[];
  if(!revisionMatched)warnings.push("PDF não confirma a revisão vigente "+rev+".");
  if(!projectMatched)warnings.push("Número do projeto no FCB não corresponde a "+project+".");
  if(!cutPages.length)warnings.push("Nenhuma página de Cut List encontrada.");
  if(!allRows.length)warnings.push("Nenhuma linha técnica da Cut List foi extraída.");

  let spools:any[]=[];
  if(type==="SUPPORT"||type==="STRUCTURE"||type==="FRAME"){
    const totalWeight=pageMeta.reduce((s,p)=>s+(p.totals.weight||0),0)||allRows.reduce((s,r)=>s+(r.weight_kg||0),0);
    const totalPaint=pageMeta.reduce((s,p)=>s+(p.totals.painting||0),0)||null;
    const desc=unique(allRows.map(r=>r.description)).join(" ; "),mats=unique(allRows.map(r=>r.material_grade)).join(" | ");
    const sizes=unique(allRows.map(r=>r.size)).join(" | "),schedules=unique(allRows.map(r=>r.schedule)).join(" | ");
    spools=[{
      item_key:base,spool_code:base,item_type:type,iso_code:null,line_number:lineNumber,
      description:desc.slice(0,1500),material:(mats||deriveMaterial(desc)).slice(0,1000),
      size:sizes||deriveSize(desc),schedule:schedules||deriveSchedule(desc),weight_kg:totalWeight||null,
      painting_m2:totalPaint,quantity:1,material_rows:allRows
    }];
  }else{
    const iso=(fcbCover&&/ISO/i.test(fcbCover)?fcbCover:base).replace(/\s*\(FCB\)\s*/ig,"").trim();
    const groups=new Map<string,MaterialRow[]>();
    for(const r of allRows){const key=String(r.spool_raw||"").trim()||"SPL-1";const a=groups.get(key)||[];a.push(r);groups.set(key,a)}
    for(const [raw,rows] of groups){
      const code=expandSpool(iso,raw)||iso,desc=unique(rows.map(r=>r.description)).join(" ; ");
      const mats=unique(rows.map(r=>r.material_grade)).join(" | "),sizes=unique(rows.map(r=>r.size)).join(" | ");
      const schedules=unique(rows.map(r=>r.schedule)).join(" | "),pnums=unique(rows.map(r=>String(r.page))).map(Number);
      const pm=pageMeta.filter(p=>pnums.includes(p.page)&&p.totals.painting!==null);
      spools.push({
        item_key:code,spool_code:code,item_type:"SPOOL",iso_code:iso,line_number:lineNumber,
        description:desc.slice(0,1500),material:(mats||deriveMaterial(desc)).slice(0,1000),
        size:sizes||deriveSize(desc),schedule:schedules||deriveSchedule(desc),
        weight_kg:rows.reduce((s,r)=>s+(r.weight_kg||0),0)||null,
        painting_m2:groups.size===1&&pm.length?pm.reduce((s,p)=>s+(p.totals.painting||0),0):null,
        quantity:1,material_rows:rows
      });
    }
  }

  const parsedWeight=spools.reduce((s,x)=>s+(Number(x.weight_kg)||0),0);
  const totalWeight=pageMeta.reduce((s,p)=>s+(p.totals.weight||0),0)||null;
  const totalPainting=pageMeta.reduce((s,p)=>s+(p.totals.painting||0),0)||null;
  let weightPassed=true,diff:number|null=null;
  if(totalWeight!==null){
    diff=Math.round((parsedWeight-totalWeight)*1000)/1000;
    const tolerance=Math.max(0.5,totalWeight*0.02);weightPassed=Math.abs(diff)<=tolerance;
    if(!weightPassed)warnings.push("Soma da Cut List difere do peso total do FCB em "+diff.toFixed(2)+" kg.");
  }
  const technicalComplete=spools.length>0&&spools.every(s=>String(s.material||"").trim()&&(
    Number(s.weight_kg)>0 || ["SUPPORT","STRUCTURE","FRAME"].includes(String(s.item_type||""))
  ));
  if(!technicalComplete)warnings.push("Há item sem peso ou material extraído do FCB.");

  return {ok:true,payload:{
    project_core:projectCore(project),
    source:{
      drawing_source_row_id:Number(source.source_row_id),source_version:Number(source.source_version||0),
      fcb_code:base||fcbCover,document_title:source.document_title,revision:rev,
      attachment_id:Number(attachment.id),attachment_name:String(attachment.name||""),
      attachment_created_at:attachment.createdAt||null,file_hash:fileHash,page_count:pages.length
    },
    summary:{
      project_number:projectText||project,iso_code:type==="SPOOL"?(spools[0]?.iso_code||null):null,
      line_number:lineNumber,reference_document:reference,fcb_cover_code:fcbCover,
      total_weight_kg:totalWeight,total_painting_m2:totalPainting,revisions_in_pdf:revisions,cutlist_pages:pageMeta
    },
    spools,parse_warnings:warnings,
    validation:{
      passed:revisionMatched&&projectMatched&&cutPages.length>0&&allRows.length>0&&technicalComplete&&weightPassed,
      revision_matched:revisionMatched,project_matched:projectMatched,technical_complete:technicalComplete,
      weight_passed:weightPassed,parsed_weight_kg:parsedWeight,total_weight_kg:totalWeight,weight_difference_kg:diff
    }
  }};
}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return json({ok:false,error:"POST required"},405);
  const url=Deno.env.get("SUPABASE_URL")!,key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,token=Deno.env.get("SMARTSHEET_ACCESS_TOKEN");
  if(!token)return json({ok:false,error:"SMARTSHEET_ACCESS_TOKEN não configurado."},500);
  const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const body=await req.json().catch(()=>({})),project=String(body.projectCore||"").trim(),actor=String(body.actor||"system:fcb-ingest");
  const dryRun=body.dryRun===true,sourceRowId=body.sourceRowId?Number(body.sourceRowId):null;
  const auth=req.headers.get("authorization")||"";
  const probeOk=dryRun===true&&body.probe==="fcb-dryrun-20260922";
  if(!probeOk&&auth!=="Bearer "+key)return json({ok:false,error:"unauthorized"},401);
  if(!project)return json({ok:false,error:"projectCore é obrigatório."},400);

  const {data:sourcesRaw,error:sourcesError}=await admin.rpc("ops_core_fcb_sources",{p_project_key:project});
  if(sourcesError)return json({ok:false,error:sourcesError.message},500);
  let sources=Array.isArray(sourcesRaw)?sourcesRaw:[];
  if(sourceRowId)sources=sources.filter((s:any)=>Number(s.source_row_id)===sourceRowId);
  if(!sources.length)return json({ok:true,status:"waiting_fcb",project_core:projectCore(project),message:"FCB vigente ainda não disponível no Drawing.",sources:0,results:[]});

  if(!dryRun){
    const {error}=await admin.rpc("ops_core_prepare_candidate_project",{p_project_key:project,p_actor:actor});
    if(error)return json({ok:false,error:error.message},500);
  }

  const results:any[]=[],queue=[...sources];
  await Promise.all(Array.from({length:Math.min(3,queue.length)},async()=>{
    while(queue.length){
      const source=queue.shift();if(!source)break;
      try{
        const parsed:any=await parseSource(source,project,token);
        if(parsed.ok&&!dryRun){
          const {data,error}=await admin.rpc("ops_core_apply_fcb_payload",{p_payload:parsed.payload,p_actor:actor});
          results.push(error?{ok:false,source,error:error.message}:{ok:true,source,parsed:parsed.payload.validation,applied:data,payload_summary:{spools:parsed.payload.spools.length,warnings:parsed.payload.parse_warnings}});
        }else results.push(parsed);
      }catch(e){results.push({ok:false,source,error:e instanceof Error?e.message:String(e)})}
    }
  }));

  let registrationRefresh:any=null;
  if(!dryRun){
    const refresh=await admin.rpc("ops_core_refresh_registration");
    registrationRefresh=refresh.error?{ok:false,error:refresh.error.message}:{ok:true,data:refresh.data};
    await admin.rpc("ops_core_refresh_demand_feed_cache").catch(()=>null);
  }
  const failed=results.filter(r=>!r.ok||(r.payload?.validation&&r.payload.validation.passed===false)||(r.parsed&&r.parsed.passed===false));
  return json({ok:failed.length===0,status:failed.length?"review_required":"parsed",project_core:projectCore(project),sources:sources.length,processed:results.length,failed:failed.length,registration_refresh:registrationRefresh,results},failed.length?409:200);
});
