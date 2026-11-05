import { randomUUID, createHash } from 'node:crypto';

const key = 'school:presence:v1';
export const syncScript = `
local now = tonumber(redis.call('TIME')[1])
local entries = redis.call('HGETALL', KEYS[1])
for i=1,#entries,2 do
  local p = cjson.decode(entries[i+1])
  if now - p.seen > 20 then redis.call('HDEL', KEYS[1], entries[i]) end
end
if ARGV[2] == 'leave' then
  redis.call('HDEL', KEYS[1], ARGV[1])
  return '{}'
end
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 and redis.call('HLEN', KEYS[1]) >= 33 then
  return 'FULL'
end
local p = cjson.decode(ARGV[2])
p.id = ARGV[1]
p.seen = now
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(p))
redis.call('EXPIRE', KEYS[1], 60)
return cjson.encode(redis.call('HVALS', KEYS[1]))
`;
const segments = new Intl.Segmenter('ko', { granularity: 'grapheme' });
export function validate(body) {
  const name = typeof body?.name === 'string' ? body.name.trim().normalize('NFC') : '';
  if (!name || [...segments.segment(name)].length > 4 || /[\p{C}\s<>]/u.test(name)) throw Error('이름은 공백 없이 최대 4글자로 입력해 주세요.');
  if (!['dong', 'buk'].includes(body.avatar)) throw Error('캐릭터를 선택해 주세요.');
  const { kind, floor, room } = body.scene || {};
  if (!['outside', 'hall', 'room'].includes(kind) || (kind !== 'outside' && !['UF','1','2','3','4','5','RF'].includes(floor)) || (kind === 'room' && (typeof room !== 'string' || room.length > 40))) throw Error('잘못된 위치입니다.');
  const position = {};
  for (const field of ['x','y','z','yaw']) {
    if (!Number.isFinite(body[field]) || Math.abs(body[field]) > (field === 'yaw' ? 100 : 1000)) throw Error('잘못된 좌표입니다.');
    position[field] = body[field];
  }
  return { name, avatar: body.avatar, scene: {kind, floor: kind === 'outside' ? null : floor, room: kind === 'room' ? room : null}, ...position, moving: !!body.moving };
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({error:'POST required'});
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) throw Error(); }
    catch { return res.status(403).json({error:'다른 사이트에서는 접속할 수 없습니다.'}); }
  }
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return res.status(503).json({error:'공유 서버 설정이 필요합니다. 배포 안내를 확인해 주세요.'});
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (JSON.stringify(body).length > 2048) throw Error('요청이 너무 큽니다.');
    if (body?.action !== 'leave') body = validate(body);
  } catch (error) { return res.status(400).json({error:error.message}); }
  const cookie = (req.headers.cookie || '').match(/(?:^|;\s*)school_session=([a-f0-9-]{36})(?:;|$)/);
  const id = cookie?.[1] || randomUUID();
  const publicId = createHash('sha256').update(id).digest('hex');
  try {
    const response = await fetch(url, {method:'POST', headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json'}, body:JSON.stringify(['EVAL',syncScript,'1',key,publicId,body.action === 'leave' ? 'leave' : JSON.stringify(body)]), signal:AbortSignal.timeout(5000)});
    if (!response.ok) throw Error('storage');
    const result = await response.json();
    if (result.error) throw Error('storage');
    if (result.result === 'FULL') return res.status(409).json({error:'현재 33명이 탐험 중이에요. 잠시 후 다시 입장해 주세요.'});
    res.setHeader('Set-Cookie', `school_session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${process.env.VERCEL ? '; Secure' : ''}`);
    const players = body.action === 'leave' ? [] : JSON.parse(result.result).map(value => {
      const {seen, ...player} = JSON.parse(value);
      return player;
    });
    return res.status(200).json({id:publicId, players, count:players.length, capacity:33});
  } catch { return res.status(503).json({error:'연결이 잠시 끊겼어요. 다시 연결 중입니다.'}); }
}
