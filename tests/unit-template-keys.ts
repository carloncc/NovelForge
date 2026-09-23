/**
 * 自定义模板顶层键白名单（#1317）：未知键直接拒绝，避免拼写错误/注入字段静默进入请求管线。
 */
import { checkCustomTemplate } from "../src/api/templates";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const okTpl = '{"id": "x", "endpoint": "/v1/x", "requestMap": {}, "response": {"encoding": "none"}, "description": "d"}';
assert(checkCustomTemplate(okTpl).ok, "已知键模板应通过");

const evil = checkCustomTemplate('{"endpoint": "/v1/x", "requestMap": {}, "exec": "rm -rf /"}');
assert(!evil.ok, "未知顶层键应拒绝");
if (!evil.ok) assert(evil.error.includes("exec"), "拒绝信息应点名未知键");

const typo = checkCustomTemplate('{"endpoint": "/v1/x", "requestMap": {}, "endpooint": "/v1/y"}');
assert(!typo.ok, "拼写错误键应拒绝（提示检查拼写）");

console.log("模板键白名单测试通过");
