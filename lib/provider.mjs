import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PROVIDER, PLACEHOLDER_KEY, SITES, accountCapabilities, readAccount, saveAccount, beijingDay } from "./accounts.mjs";
import { createAccountOperations } from "./account-operations.mjs";
import { createSiteClient, parseSessionHandoff } from "./site-client.mjs";
import { MODEL_HINT_HEADER, customHeaders, inferenceHeaders } from "./headers.mjs";
import { createCatalog, protocolOfURL } from "./catalog.mjs";
import { createModelRegistry } from "./model-registry.mjs";
import { declaredConfigModels } from "./declared-models.mjs";
import { readUsage, quotaRate } from "./usage.mjs";
import { prepareRequest, prepareAnthropicRequest, prepareCodexRequest } from "./request.mjs";
import { loadTextFilter } from "./content-filter.mjs";
import { explainResponse } from "./response.mjs";
import { SessionRepairError } from "./session-repair.mjs";
import { positiveId, redactedMessage, throwIfAborted, trustedURL, usableModelKey } from "./safety.mjs";

const SITE = SITES.top, MODEL_BASE = `${SITE}/v1`;
const required = value => typeof value === "string" && value.trim() ? undefined : "此项必填。";
function prompts(mode) {
  const out = [];
  if (mode === "api-key") out.push({type:"text",key:"email",message:"账号邮箱（可选，仅作显示名）",validate:v=>!v?.trim()||/^[^\s@]+@[^\s@]+$/.test(v.trim())?undefined:"请输入邮箱或留空"});
  if (mode === "password") out.push(
    {type:"text",key:"username",message:"AnyRouter 站点用户名或邮箱",validate:required},
    {type:"password",key:"password",message:"AnyRouter 站点密码（不是 GitHub/LinuxDO 密码）",validate:required},
    {type:"select",key:"savePassword",message:"是否保存本站密码用于会话失效后的签到登录？",options:[{label:"否 - 只保存会话",value:"no"},{label:"是 - 保存密码",value:"yes"}]} );
  if (mode === "access-token") out.push(
    {type:"password",key:"accessToken",message:"系统访问令牌（不是模型 API Key）",validate:required},
    {type:"text",key:"userId",message:"用户 ID（New-Api-User 正整数）",validate:v=>positiveId(v)?undefined:"请输入纯数字用户 ID。"} );
  if (mode !== "api-key") out.push(
    {type:"password",key:"modelKey",message:"已有模型 API Key（可选；留空时尝试只读发现，未发现则仅余额/签到）",validate:v=>!v||usableModelKey(v)?undefined:"模型 Key 无效、被掩码或含空白。"},
    {type:"text",key:"keyId",message:"已有模型 Key ID（可选；多把 Key 时指定一把，绝不创建/轮换）",validate:v=>!v||positiveId(v)?undefined:"Key ID 必须是正整数。"} );
  out.push({type:"text",key:"headers",message:"自定义模型请求头（可选，每行 Name: value）",validate:v=>{try{customHeaders(v);return undefined}catch{return "请求头格式无效或包含受管字段"}}});
  return out;
}
function accountFromInputs(mode, inputs = {}) {
  if (inputs.apiEndpoint && inputs.apiEndpoint !== "top") throw new Error("模型端点只支持 anyrouter.top");
  if (inputs.modelKey && !usableModelKey(inputs.modelKey)) throw new Error("请填写完整有效模型 API Key 或留空");
  if (inputs.keyId && !positiveId(inputs.keyId)) throw new Error("模型 Key ID 必须是正整数");
  customHeaders(inputs.headers ?? "");
  return {mode,site:"top",siteURL:SITE,apiBase:MODEL_BASE,key:"",keyId:String(inputs.keyId??"").trim(),email:"",label:"",
    username:mode==="password"?String(inputs.username??"").trim():"",
    password:mode==="password"?String(inputs.password??""):"",
    accessToken:mode==="access-token"?String(inputs.accessToken??"").trim():"",
    userId:mode==="access-token"?positiveId(inputs.userId):"",session:"",headers:inputs.headers??"",
    checkinEnabled:mode!=="api-key"&&mode!=="access-token"&&(mode!=="password"||inputs.savePassword==="yes"),loginGeneration:randomUUID()};
}
const failed = (error, account = {}) => ({type:"failed",error:redactedMessage(error?.name==="AbortError"||error?.name==="TimeoutError"?"登录已取消或超时":error?.message||"站点未能完成登录",account)});
async function finishLogin(op, inputs = {}, now = Date.now()) {
  const profile = await op.profile();
  let key = String(inputs.modelKey??"").trim(), keyId = String(inputs.keyId??"").trim();
  if (!key) {
    try {const found = await op.selectKey(keyId);key=found.key;keyId=found.keyId;}
    catch(error){throwIfAborted(op.signal);if(keyId || ["credentials","identity","forbidden"].includes(error?.kind))throw error;}
  }
  const state={...profile.account,...op.account(),key,keyId,hasModelKey:usableModelKey(key)};
  const {type,...record}=saveAccount(state, {}, now);
  return {type:"success",...record};
}
function requestURL(request, init, headers, account, provider, explicit) {
  const original = trustedURL(request, { model:true });
  const protocol = protocolOfURL(original.href);
  if (!protocol) return original.href;
  let id = headers.get(MODEL_HINT_HEADER);
  if (!id && typeof init.body === "string" && init.body.length <= 4*1024*1024) {try{id=JSON.parse(init.body).model;}catch{}}
  const entry = Object.entries(explicit.models??{}).find(([name,m])=>name===id||(m.id||name)===id)?.[1];
  const base = entry?.provider?.api || account.apiBase || explicit.api || MODEL_BASE;
  const validBase = trustedURL(base, {base:true});
  const normalized = validBase.href.replace(/\/+$/, "").replace(/\/(?:v1beta)$/, "/v1");
  const root = /\/v1$/.test(normalized)?normalized:`${normalized}/v1`;
  const suffix = original.pathname.match(/\/(?:responses|chat\/completions|messages)\/?$/)?.[0];
  return suffix ? trustedURL(root + suffix + original.search,{model:true}).href : original.href;
}
function checkinFailure(error, account = {}) {
  const kind=error?.kind;
  return {outcome:kind==="captcha"||kind==="waf"?"captcha":["credentials","forbidden","identity"].includes(kind)?"ineligible":kind==="inactive"?"inactive":kind==="already"?"done":"failed",
    message:redactedMessage(error?.message||"AnyRouter 签到未确认成功",account)};
}
const authOptions = [
  {key:"send-codex-headers",label:"发送 Codex 客户端请求头",description:"仅控制 Responses 的客户端请求头和兼容字段；不影响 Claude。",default:true},
  {key:"claude-code-compat",label:"Claude Code 请求兼容",description:"仅控制 Messages 的请求头、beta 参数和 system/metadata；关闭后不注入。",default:true},
  {key:"portable-responses",label:"内联发送完整的 Responses 历史",description:"只内联已知且完整的消息和工具，不处理不透明历史。",default:true},
  {key:"text-filter",label:"发送前替换本地词表中的文字",description:"仅处理 Responses 可见正文；无词表不替换。",default:true},
  {key:"codex-session-repair",label:"清理 Codex 会话的旧资源绑定（有损）",description:"默认关闭，清理后的工具关联必须完整；可能丢失历史上下文。",confirm:"会丢弃发送副本中的加密、压缩或仅引用历史，可能丢失上下文。确认开启？",default:false},
  {key:"request-diagnostics",label:"响应错误诊断",description:"只改写尚未产生内容的明确错误；保留部分输出，绝不重试。",default:true},
];

export async function createProvider(input = {}, options = {}, dependencies = {}) {
  const fetchImpl=dependencies.fetchImpl||((...args)=>fetch(...args)), now=dependencies.now||Date.now;
  const timeoutMs=options.siteTimeoutMs??30000, rate=quotaRate(options.quotaPerUnit??500000);
  const site=createSiteClient({fetchImpl,now,timeoutMs});
  const operations=createAccountOperations({site,client:input.client,timeoutMs,now});
  const completed = new Map();
  let explicit={}, lastConfig;
  const enabled = key => input.magpie?.option?.(PROVIDER,key) !== false;
  const loadRegistry=dependencies.loadRegistry||createModelRegistry({fetchImpl,...(options.modelsRegistryPath?{paths:[options.modelsRegistryPath]}:{})});
  const catalog=createCatalog({site,explicit:()=>explicit,compatibility:()=>enabled("send-codex-headers"),fetchImpl,loadRegistry});

  function siteMethod(mode, label) {
    const automatic=mode==="password"||mode==="access-token";
    return {type:"oauth",label,prompts:prompts(mode),async authorize(inputs={}, {signal}={}) {
      throwIfAborted(signal);
      let account;
      try {account=accountFromInputs(mode,inputs);}catch(error){return failed(error);}
      let used=false;
      return {url:automatic?"":`${SITE}/login`,method:automatic?"auto":"code",
        instructions:automatic?(mode==="password"?"正在登录并校验本站账号和已有 Key；包含一次认证 POST，不会额外签到或创建/轮换令牌。":"正在只读校验本站账号和已有 Key；不会签到或创建/轮换令牌。"):"请在浏览器完成本站登录及验证，粘贴 /api/user/self 的 cURL 或 {cookie,userId} JSON（不执行命令）。不要把凭据发送到聊天或日志。",
        async callback(value,{signal:callbackSignal}={}) {
          if(used)return failed(new Error("这次登录已经完成，请重新发起。"));used=true;
          let op;
          try {
            throwIfAborted(signal);throwIfAborted(callbackSignal);
            const combined=signal&&callbackSignal?AbortSignal.any([signal,callbackSignal]):callbackSignal||signal;
            if(!automatic) {const handoff=parseSessionHandoff(value);account={...account,...handoff,accessToken:"",password:""};}
            op=site.openSession(account,{signal:combined});
            if(mode==="password")await op.login();
            return await finishLogin(op,inputs,now());
          }catch(error){return failed(error,account);}finally{op?.close();}
        }};
    }};
  }
  const methods=[
    siteMethod("password","AnyRouter 账号密码（可选保存密码）"),
    siteMethod("github","GitHub 登录 AnyRouter（浏览器会话交接）"),
    siteMethod("linuxdo","LinuxDO 登录 AnyRouter（浏览器会话交接）"),
    siteMethod("session","浏览器会话（余额与每日签到）"),
    siteMethod("access-token","系统访问令牌（读取已有 Key，不签到）"),
    {type:"api",label:"AnyRouter 模型 API Key（仅推理）",placeholder:"sk-…",prompts:prompts("api-key")}
  ];
  return {
    async config(cfg) {
      cfg.provider??={};
      // A host may call config twice on the object already modified by us. Do
      // not reinterpret plugin defaults as fresh user override declarations.
      if(cfg.provider[PROVIDER]!==lastConfig)explicit=structuredClone(cfg.provider[PROVIDER]??{});
      const p=cfg.provider[PROVIDER]??={name:"AnyRouter",npm:"@ai-sdk/anthropic",api:MODEL_BASE,models:declaredConfigModels()};
      p.api??=MODEL_BASE;p.npm??="@ai-sdk/anthropic";p.models??=declaredConfigModels();lastConfig=p;
    },
    auth:{provider:PROVIDER,methods,icon:`data:image/png;base64,${readFileSync(new URL("../icon.png",import.meta.url)).toString("base64")}`,options:authOptions.map(o=>({...o})),
      async loader(getAuth,provider={}) {
        const initial=readAccount(await getAuth(),provider,now());if(!initial)return{};
        const sameInference = a => a && a.key===initial.key && a.userId===initial.userId && a.apiBase===initial.apiBase && a.loginGeneration===initial.loginGeneration;
        let filterPromise;
        return {apiKey:initial.hasModelKey?initial.key:PLACEHOLDER_KEY,async fetch(request,init={}) {
          const signal=init.signal??(request instanceof Request?request.signal:undefined);
          throwIfAborted(signal);
          let account;try{account=readAccount(await getAuth(),provider,now());}catch{return localError("anyrouter_invalid_account","账号记录无效，请重新登录",400);}
          if(!account)return localError("anyrouter_missing_account","AnyRouter 账号已移除",401);
          if(!accountCapabilities(account,now()).inference)return localError("anyrouter_missing_api_key","该账号仅余额/签到，没有有效模型 API Key。请重新登录并填写 Key 或目标 Key ID。",400);
          if(!sameInference(account))return localError("anyrouter_account_changed","请求期间账号或模型 Key 已变化，请重新发起",409);
          const incoming=new Headers(request instanceof Request?request.headers:undefined);new Headers(init.headers).forEach((v,k)=>incoming.set(k,v));
          let url;try{url=requestURL(request,init,incoming,account,provider,explicit);}catch{return localError("anyrouter_untrusted_destination","已阻止向非受信任地址或未知接口发送模型 Key",400);}
          const protocol=protocolOfURL(url), compat=protocol==="anthropic"?enabled("claude-code-compat"):enabled("send-codex-headers");
          const headers=inferenceHeaders(account,incoming,protocol,compat);
          let target=request instanceof Request?new Request(url,request):url;
          let prepared={...init,headers,redirect:"manual",signal};
          try {
            if(protocol==="responses") {
              if(compat)prepared=await prepareCodexRequest(target,prepared);
              const filter=enabled("text-filter")?await (filterPromise??=loadTextFilter()):null;
              prepared=await prepareRequest(target,prepared,{portableResponses:enabled("portable-responses"),textFilter:filter,sessionRepair:input.magpie?.option?.(PROVIDER,"codex-session-repair")===true});
            } else if(protocol==="anthropic"&&compat)prepared=await prepareAnthropicRequest(target,prepared);
          }catch(error){throwIfAborted(signal);if(error instanceof SessionRepairError)return localError(error.code,error.message,400);return localError("anyrouter_request_config","请求兼容或本地词表配置无效，未发送请求",400);}
          if(prepared.url){url=prepared.url;target=target instanceof Request?new Request(url,target):url;prepared={...prepared};delete prepared.url;}
          try{trustedURL(url,{model:true});}catch{return localError("anyrouter_untrusted_destination","已阻止非受信任的请求目标",400);}
          throwIfAborted(signal);if(!sameInference(readAccount(await getAuth(),provider,now())))return localError("anyrouter_account_changed","准备期间账号已变化，未发送",409);
          const response=await fetchImpl(target,{...prepared,redirect:"manual"});
          if(response.status>=300&&response.status<400){void response.body?.cancel().catch(()=>{});return localError("anyrouter_upstream_redirect","模型接口返回重定向，已阻止转发凭据",502);}
          return enabled("request-diagnostics")?explainResponse(response,{retryAfterSeconds:account.retryAfterSeconds??explicit.retryAfterSeconds??options.retryAfterSeconds,signal,account}):response;
        }};
      },
      async usage(getAuth,provider={}, {signal}={}) {
        try {
          const account=readAccount(await getAuth(),provider,now());if(!account)return{error:"未连接 AnyRouter 账号",windows:[],signIn:"kept"};
          if(account.mode==="api-key")return await readUsage(site,account,{quotaPerUnit:rate,now,fetchImpl,signal});
          return await operations.run("usage",getAuth,provider,signal,async({account,op,persist,check,signal})=>{
            const result=await readUsage(op,account,{quotaPerUnit:rate,now,fetchImpl,signal});await check();
            try{if(!await persist())return{...result,error:"读取完成，但账号凭据存储不可用或登录已变化，请重新检查",signIn:"kept"};}catch{return{...result,error:"读取完成，但 Cookie 状态保存失败",signIn:"kept"};}
            return result;
          });
        }catch(error){throwIfAborted(signal);return{error:redactedMessage(error?.message||"读取账号失败"),windows:[],signIn:"kept"};}
      },
      async checkin(getAuth, provider = {}, { signal } = {}) {
        try {
          return await operations.run("checkin", getAuth, provider, signal, async ({ account, op, persist, check, signal }) => {
            if (!accountCapabilities(account, now()).checkin) {
              return { outcome: "ineligible", message: "每日签到需要本站有效会话或已保存本站密码" };
            }
            let day = beijingDay(now());
            const key = `${account.siteURL}:${account.userId}:${account.loginGeneration}`;
            for (const [k, v] of completed) if (v.day !== day) completed.delete(k);
            if (account.lastCheckinDay === day && ["claimed", "done"].includes(account.lastCheckin?.outcome) || completed.get(key)?.day === day) {
              return { outcome: "done", message: "该账号今天的签到已确认完成" };
            }
            let result;
            try {
              // Network/WAF failures are not permission to log in again. Use
              // a saved password only after a refused or expired site session.
              try { await op.self(); }
              catch (error) {
                throwIfAborted(signal);
                if (error.kind !== "credentials" || !account.password) throw error;
                await op.login(); await op.self();
              }
              await check();
              const confirmed = site.checkinResult(await op.signIn());
              result = confirmed.lastCheckin;
              // Preflight or queue waits may cross Beijing midnight. Record the
              // confirmation day rather than the day captured before the GET.
              day = confirmed.lastCheckinDay;
            } catch (error) {
              throwIfAborted(signal);
              result = checkinFailure(error, account);
            }
            const success = ["claimed", "done"].includes(result.outcome);
            if (success) completed.set(key, { day });
            try {
              const patch = success ? { lastCheckinDay: day, lastCheckin: result } : {};
              if (!await persist(patch)) {
                return { ...result, message: `${result.message}；登录已变化或本地存储不可用，旧 Cookie 未保存` };
              }
            } catch { return { ...result, message: `${result.message}；本地 Cookie 保存失败` }; }
            return result;
          });
        } catch (error) {
          throwIfAborted(signal);
          return checkinFailure(error);
        }
      }
    },
    provider:{id:PROVIDER,models:(provider,{auth,signal}={})=>catalog(provider,readAccount(auth,provider,now()),{signal})},
    "chat.headers":async(context,output)=>{
      if(context.model?.providerID!==PROVIDER&&context.provider?.info?.id!==PROVIDER)return;
      output.headers??={};const h=new Headers(output.headers), supplied=new Headers(context.model?.headers);
      const modelId=context.model?.id||context.model?.api?.id;if(modelId)output.headers[MODEL_HINT_HEADER]=modelId;
      if(context.sessionID&&!supplied.has("x-session-id")&&!h.has("x-session-id"))output.headers["x-session-id"]=context.sessionID;
      if(context.sessionID&&context.model?.api?.npm==="@ai-sdk/anthropic"&&!supplied.has("x-claude-code-session-id")&&!h.has("x-claude-code-session-id"))output.headers["x-claude-code-session-id"]=context.sessionID;
    }
  };
}
function localError(code,message,status){return Response.json({error:{type:"invalid_request_error",code,message}},{status,headers:{"x-magpie-sign-in":"kept"}});}
export const _internal={prompts,accountFromInputs,finishLogin,requestURL,checkinFailure};
