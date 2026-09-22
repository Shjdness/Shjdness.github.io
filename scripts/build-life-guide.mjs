import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repository = 'Shjdness/HowToLiveBetter';
const output = resolve('client/public/life-guide.json');
const api = `https://api.github.com/repos/${repository}/contents/book?ref=main`;
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Shjdness-Life-Guide-Builder' };

const categoryFor = (chapter, title) => {
  const text = `${chapter} ${title}`;
  if (/时间|精力/.test(text)) return '时间与精力';
  if (/放松|娱乐|压力/.test(text)) return '放松与娱乐';
  if (/技能|学习|十八岁|留学/.test(text)) return '学习与技能';
  if (/账号|信息安全|网站|平台/.test(text)) return '信息与平台安全';
  if (/紧急|急救/.test(text)) return '急救与应急';
  if (/旅行|出国|境外/.test(text)) return '旅行安全';
  if (/法律|财产|钱|租房|买房|工伤|离职|创业|生意/.test(text)) return '财产与法律风险';
  if (/怀孕|孩子|老人|慢性病|残疾/.test(text)) return '家庭与照护';
  return '健康与生活';
};

const featured = new Set(['时间与精力', '放松与娱乐', '学习与技能', '信息与平台安全', '急救与应急', '旅行安全', '财产与法律风险']);

function parseField(body, name) {
  const match = body.match(new RegExp(`^\\s*[-*]\\s*${name}：\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() || '';
}

function parseBook(markdown, fileName) {
  const chapterMatch = markdown.match(/^#\s+(\d+)\.\s+(.+)$/m);
  if (!chapterMatch) return [];
  const chapterNumber = Number(chapterMatch[1]);
  const chapter = chapterMatch[2].trim();
  const matches = [...markdown.matchAll(/^###\s+(\d+)\.\s+(.+)$/gm)];
  return matches.map((match, index) => {
    const body = markdown.slice(match.index, matches[index + 1]?.index || markdown.length).trim();
    const itemNumber = Number(match[1]);
    const title = match[2].trim();
    const category = categoryFor(chapter, title);
    return {
      id: `${String(chapterNumber).padStart(2, '0')}-${String(itemNumber).padStart(3, '0')}`,
      title,
      summary: parseField(body, '说人话') || parseField(body, '收益'),
      category,
      evidence: parseField(body, '证据等级').replace(/\s.*/, '') || 'C',
      cost: parseField(body, '成本'),
      benefit: parseField(body, '收益'),
      source: parseField(body, '来源'),
      detail: parseField(body, '备注'),
      chapter,
      chapterNumber,
      itemNumber,
      featured: featured.has(category),
      sourceUrl: `https://github.com/${repository}/blob/main/book/${encodeURIComponent(fileName)}`,
    };
  });
}

async function build() {
  const listResponse = await fetch(api, { headers });
  if (!listResponse.ok) throw new Error(`GitHub contents API returned ${listResponse.status}`);
  const files = (await listResponse.json()).filter(item => item.type === 'file' && item.name.endsWith('.md'));
  const entries = [];
  for (const file of files) {
    const response = await fetch(file.download_url, { headers });
    if (!response.ok) throw new Error(`Cannot download ${file.name}: ${response.status}`);
    entries.push(...parseBook(await response.text(), file.name));
  }
  entries.sort((a, b) => a.chapterNumber - b.chapterNumber || a.itemNumber - b.itemNumber);
  if (entries.length < 100) throw new Error(`Only parsed ${entries.length} guide entries`);
  await writeFile(output, `${JSON.stringify({ generatedAt: new Date().toISOString(), repository, count: entries.length, entries })}\n`);
  console.log(`Generated ${entries.length} Life Guide entries.`);
}

build().catch(async error => {
  try {
    const fallback = JSON.parse(await readFile(output, 'utf8'));
    if (!Array.isArray(fallback.entries) || fallback.entries.length === 0) throw new Error('fallback is empty');
    console.warn(`Guide refresh skipped (${error.message}); keeping ${fallback.entries.length} bundled entries.`);
  } catch {
    console.error(error);
    process.exitCode = 1;
  }
});
