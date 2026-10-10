/**
 * LLM 客户端 —— 对接 free-llm-gateway（OpenAI Chat Completions 兼容）。
 *
 * 配置放 .env（不进 git）：
 *   LLM_BASE_URL = 工作台顶部 Base URL（云端以 /llm/v1 结尾）
 *   LLM_API_KEY  = 网关密钥
 *   LLM_MODEL    = 模型名（默认 auto-ops = 用已保存组合）
 *   LLM_VISION_MODEL = 有图像输入能力的型号（复刻脚本/截图分析用；不填则用 LLM_MODEL）
 *
 * 没配置时所有 AI 功能给出明确的「未配置」错误，不静默失败。
 */
const path = require('path');
const envfile = require('./envfile');

const BASE_DIR = process.env.TT_BASE_DIR || path.join(__dirname, '..');

function cfg() {
  const env = envfile.read(path.join(BASE_DIR, '.env'));
  const base = (process.env.LLM_BASE_URL || env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const key = process.env.LLM_API_KEY || env.LLM_API_KEY || '';
  const model = process.env.LLM_MODEL || env.LLM_MODEL || 'auto-ops';
  const vision = process.env.LLM_VISION_MODEL || env.LLM_VISION_MODEL || model;
  if (!base || !key) {
    throw new Error('AI 未配置：请在 .env 填 LLM_BASE_URL 和 LLM_API_KEY（值来自 free-llm-gateway 工作台顶部的 Connection Details）');
  }
  return { base, key, model, vision };
}

/** 纯文本对话。messages: [{role, content}] */
async function chat(messages, opts = {}) {
  const { base, key, model } = cfg();
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: opts.model || model,
      messages,
      temperature: opts.temperature === undefined ? 0.4 : opts.temperature,
      max_tokens: opts.maxTokens,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) {
    throw new Error(`LLM 请求失败 HTTP ${res.status}: ${(j.error && (j.error.message || j.error)) || '无响应体'}`);
  }
  const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!content) throw new Error('LLM 返回空内容（HTTP ' + res.status + '）');
  return content;
}

/** 视觉对话：parts 里可含 {type:'image_url', image_url:{url:'data:image/jpeg;base64,…'}} */
async function chatVision(text, images, opts = {}) {
  const { vision } = cfg();
  const parts = [{ type: 'text', text }];
  for (const b64 of images) parts.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } });
  return chat([{ role: 'user', content: parts }], { ...opts, model: vision });
}

module.exports = { chat, chatVision, cfg };
