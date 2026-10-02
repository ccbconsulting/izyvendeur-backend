'use strict';
// Adresse IP réelle du client derrière Cloudflare (CF-Connecting-IP retenu seulement si la requête vient de Cloudflare).
const net = require('net');
const V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14',
  '172.64.0.0/13', '131.0.72.0/22'];
const V6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];
const list = new net.BlockList();
for (const r of [...V4, ...V6, ...String(process.env.CLOUDFLARE_IPS || '').split(',').map((s) => s.trim()).filter(Boolean)]) {
  const [ip, bits] = r.split('/');
  try { list.addSubnet(ip, Number(bits), net.isIPv6(ip) ? 'ipv6' : 'ipv4'); } catch (_) {}
}
function isCloudflare(ip) {
  if (!ip) return false;
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const type = net.isIPv4(v) ? 'ipv4' : net.isIPv6(v) ? 'ipv6' : null;
  return type ? list.check(v, type) : false;
}
function clientIp(req, res, next) {
  const cf = String(req.get('cf-connecting-ip') || '').trim();
  if (cf && net.isIP(cf) && isCloudflare(req.ip)) Object.defineProperty(req, 'ip', { value: cf, configurable: true });
  next();
}
module.exports = { clientIp, isCloudflare };
