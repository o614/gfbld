// api/wechat.js
const crypto = require('crypto');
const { Parser, Builder } = require('xml2js');
const { ALL_SUPPORTED_REGIONS, DSF_MAP } = require('../consts');

const WECHAT_TOKEN = process.env.WECHAT_TOKEN;
if (!WECHAT_TOKEN) throw new Error('缺少 WECHAT_TOKEN 环境变量');

const parser = new Parser({ explicitArray: false, trim: true });
const builder = new Builder({ cdata: true, rootName: 'xml', headless: true });

// 预处理字典，提升查询速度
const REGION_NAME_TO_CODE = {};
for (const [name, code] of Object.entries(ALL_SUPPORTED_REGIONS)) {
  REGION_NAME_TO_CODE[name] = code;
}

// 核心业务：生成切换链接
function handleRegionSwitch(regionInput) {
  const trimmed = String(regionInput || '').trim();
  const regionCode = REGION_NAME_TO_CODE[trimmed];
  const dsf = regionCode ? DSF_MAP[regionCode] : null;

  if (!regionCode || !dsf) return '不支持的地区或格式错误，请发送例如：切换 美国';

  const rawUrl = `itms-apps://itunes.apple.com/WebObjects/MZStore.woa/wa/resetAndRedirect?dsf=${dsf}&cc=${regionCode}`;
  const qrUrl = `https://quickchart.io/qr?size=400&margin=2&text=${encodeURIComponent(rawUrl)}`;

  return `请长按复制下方蓝字去 Safari 浏览器地址栏粘贴并打开。\n\n` +
    `地区【${trimmed}】：\n` +
    `<a href="weixin://">${rawUrl}</a>\n\n` +
    `若无法复制，可提取备用码。\n` +
    `› <a href="${qrUrl}">点击提取</a>\n\n` +
    `*数据来源：#公众号：不要艾特我\n`;
}

// Vercel Serverless 入口
module.exports = async (req, res) => {
  const { signature, timestamp, nonce, echostr } = req.query;
  const params = [WECHAT_TOKEN, timestamp, nonce].sort();
  const hash = crypto.createHash('sha1').update(params.join('')).digest('hex');

  // 1. 微信后台配置验证
  if (hash !== signature) return res.status(403).send('Invalid Signature');
  if (req.method === 'GET') return res.status(200).send(echostr || '');

  // 2. 处理粉丝消息
  if (req.method === 'POST') {
    try {
      // 提取 POST 请求体
      const rawBody = await new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => (body += chunk.toString('utf-8')));
        req.on('end', () => resolve(body));
        req.on('error', reject);
      });

      // 解析 XML
      const parsedXml = await parser.parseStringPromise(rawBody);
      const message = parsedXml.xml || {};
      let replyContent = '';

      // 关注回复
      if (message.MsgType === 'event' && message.Event === 'subscribe') {
        replyContent = '欢迎关注！请直接回复“切换+地区名称”，例如：\n\n切换 美国\n切换 日本';
      } 
      // 文本回复
      else if (message.MsgType === 'text' && typeof message.Content === 'string') {
        const content = message.Content.trim();
        const match = content.match(/^(切换|地区)\s*([a-zA-Z\u4e00-\u9fa5\s]+)$/i);
        
        if (match && match[2]) {
          replyContent = handleRegionSwitch(match[2]);
        } else if (content.includes('切换')) {
            replyContent = '格式不正确哦，请发送例如：切换 美国';
        }
      }

      // 如果有回复内容，构建 XML 返回
      if (replyContent) {
        const xmlResponse = builder.buildObject({
          ToUserName: message.FromUserName,
          FromUserName: message.ToUserName,
          CreateTime: Math.floor(Date.now() / 1000),
          MsgType: 'text',
          Content: replyContent
        });
        return res.setHeader('Content-Type', 'application/xml').status(200).send(xmlResponse);
      }
      
      // 无匹配指令，直接静默
      return res.status(200).send('');

    } catch (error) {
      console.error('处理消息失败:', error);
      return res.status(200).send('');
    }
  }
};

// Vercel 配置：必须禁用默认的 bodyParser，才能正确接收微信的 XML 原始流
module.exports.config = {
  api: { bodyParser: false }
};
