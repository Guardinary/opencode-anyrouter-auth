import { inferenceHeaders } from "./headers.mjs";
import { readBoundedText } from "./site-client.mjs";
import { resolveModelMetadata } from "./model-metadata.mjs";
import { createPublicPricing, modelPricing } from "./model-pricing.mjs";
import { createModelRegistry } from "./model-registry.mjs";
import { declaredModels } from "./declared-models.mjs";
import { ANYROUTER_ORIGIN, deadlineSignal, isRecord, throwIfAborted, trustedURL, usableModelKey } from "./safety.mjs";
export { protocolOfURL } from "./protocols.mjs";
export const NPMS=Object.freeze({responses:"@ai-sdk/openai",chat:"@ai-sdk/openai-compatible",anthropic:"@ai-sdk/anthropic",gemini:"@ai-sdk/google"});
const validId = id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(id) && !["constructor","prototype","__proto__"].includes(id);
export function protocolForModel(id) {
  if (/^claude-|cc-format$/i.test(id ?? "")) return "anthropic";
  return /^gemini-/i.test(id ?? "") ? "gemini" : "responses";
}
const fromNpm = npm => /anthropic/.test(npm)?"anthropic":npm==="@ai-sdk/google"?"gemini":["@ai-sdk/openai","@ai-sdk/azure"].includes(npm)?"responses":"chat";
function protocolChoice(row,user) {
  if(user.provider?.npm)return {protocol:fromNpm(user.provider.npm),npm:user.provider.npm};
  const aliases = { google: "gemini", "openai-response": "responses", "openai-responses": "responses", openai: "responses" };
  const types = (Array.isArray(row.supported_endpoint_types) ? row.supported_endpoint_types : [])
    .filter(type => typeof type === "string")
    .map(type => Object.hasOwn(aliases, type) ? aliases[type] : type).filter(type => Object.hasOwn(NPMS, type));
  const family=protocolForModel(row.id);
  const protocol=types.includes(family)?family:types[0]??family;
  return {protocol,npm:NPMS[protocol]};
}
function modelBase(user,account,explicit,protocol="responses") {
  const base=user.provider?.api||account?.apiBase||explicit.api||`${ANYROUTER_ORIGIN}/v1`;
  trustedURL(base,{base:true});
  // Account credentials store one base, while model SDKs require distinct API
  // versions. Discovery remains /v1/models even for native Google models.
  return `${ANYROUTER_ORIGIN}/${protocol === "gemini" ? "v1beta" : "v1"}`;
}
export function buildCatalog(rows,provider={},account={},explicit={},pricing=[],registry={},priceContext={}) {
  const out=Object.create(null),declared=declaredModels();
  const meta=new Map(pricing.filter(r=>isRecord(r)&&validId(r.model_name)).map(r=>[r.model_name,r]));
  const quotes = new Map();
  for (const item of pricing) if (isRecord(item) && validId(item.model_name)) {
    quotes.set(item.model_name, quotes.has(item.model_name) ? null : item);
  }
  for(const row of rows) {
    if(!isRecord(row)||!validId(row.id))continue;
    const aliases=Object.entries(explicit.models??{}).filter(([name,m])=>isRecord(m)&&(m.id||name)===row.id);
    for(const [name,user] of aliases.length?aliases:[[row.id,{}]]) {
      if(!validId(name)||user.disabled)continue;
      const original=declared[row.id]??{};
      // Host-filled API/capabilities are not evidence of explicit declarations.
      // Use our own model metadata as fallback; retain genuine host limit/options
      // only for an unknown model that has no corresponding plugin declaration.
      const base=Object.hasOwn(declared,row.id)?original:(provider.models?.[name]??provider.models?.[row.id]??{});
      const choice=protocolChoice(row,user), url=modelBase(user,account,explicit,choice.protocol);
      const metadata=resolveModelMetadata({id:row.id,providerId:provider.id||"anyrouter",registry,user,row,pricing:meta.get(row.id),base});
      const cost = modelPricing(user, quotes.get(row.id), explicit.pricingGroup, priceContext.groupRatios);
      // Unknown models cannot inherit a false reasoning/image claim from the
      // provider-wide placeholder schema; authenticated flags/registry may fill it.
      out[name]={id:name,providerID:provider.id||"anyrouter",name:user.name||row.name||row.display_name||base.name||name,
        api:{id:row.id,url,npm:choice.npm},...metadata,...(cost ? { cost } : {}),
        headers:{...base.headers,...user.headers},options:{...base.options,...user.options},
        ...(Array.isArray(row.supported_endpoint_types)?{endpoints:[...row.supported_endpoint_types]}:{})};
    }
  }
  return out;
}
export function createCatalog({site,explicit=()=>({}),compatibility=()=>true,fetchImpl=(...args)=>fetch(...args),loadRegistry=createModelRegistry({fetchImpl}),now=Date.now}) {
  const publicPricing = createPublicPricing({site,now});
  function fallback(provider,account,failed=false) {
    const settings=explicit(), rows=Object.keys(declaredModels()).map(id=>({id}));
    for(const [name,m]of Object.entries(settings.models??{}))if(isRecord(m)&&validId(m.id||name)&&!rows.some(r=>r.id===(m.id||name)))rows.push({id:m.id||name});
    const models=buildCatalog(rows,{id:provider?.id||"anyrouter",models:{}},account??{},settings);
    if(failed)models[Symbol.for("magpie.fellBack")]=true;
    return models;
  }
  return async(provider={},account,{signal}={})=>{
    throwIfAborted(signal);
    if(!account)return fallback(provider,null);
    if(!account.hasModelKey||!usableModelKey(account.key))return{};
    const budget=deadlineSignal(signal,25000);
    try {
      const settings=explicit(),base=modelBase({},account,settings);
      const response=await fetchImpl(trustedURL(`${base}/models`,{model:true}).href,{headers:inferenceHeaders(account,settings.headers,"responses",compatibility()),redirect:"manual",signal:budget.signal});
      const text=await readBoundedText(response,2*1024*1024,{signal:budget.signal,timeoutMs:25000});
      let value;try{value=JSON.parse(text);}catch{}
      if(response.status===401&&isRecord(value)) {
        const message=typeof value.error==="string"?value.error:value.error?.message??value.message??"";
        const rejected=/unauthorized client detected|invalid (?:claude code|codex) request/i.test(message);
        throw Object.assign(new Error(rejected?"网关拒绝客户端标识，模型 Key 未被判定失效":"模型接口拒绝了 API Key，请重新连接账号"),{signIn:rejected?"kept":"expired"});
      }
      if(!response.ok||!Array.isArray(value?.data)||value.data.some(r=>!isRecord(r)||!validId(r.id)))return fallback(provider,account,true);
      if(!value.data.length)return{}; // A successful empty list is authoritative.
      const pricing=publicPricing(budget.signal);
      const [prices,registry]=await Promise.all([pricing,loadRegistry({signal:budget.signal})]);throwIfAborted(budget.signal);
      return buildCatalog(value.data,provider,account,settings,prices.rows,registry,prices);
    }catch(error){throwIfAborted(budget.signal);if(error.signIn)throw error;return fallback(provider,account,true);}
    finally{budget.close();}
  };
}
