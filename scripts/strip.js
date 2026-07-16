const { writeFileSync, readFileSync, readdirSync } = require('fs');
const { join } = require('path');

const protectTemplateLiterals = (code) => {
  const templates = [];
  const protectedCode = code.replace(/`(?:\\[\s\S]|[^`])*`/g, (template) => {
    const token = `__OPENASAR_TEMPLATE_LITERAL_${templates.length}__`;
    templates.push([token, template]);
    return token;
  });

  return {
    code: protectedCode,
    restore: (stripped) => templates.reduce((result, [token, template]) => result.replace(token, () => template), stripped)
  };
};

const stripCode = (code) => {
  const protectedTemplates = protectTemplateLiterals(code);
  const stripped = protectedTemplates.code
    .replace(/(^| )\/\/.*$/gm, '')
    .replaceAll('const ', 'const~')
    .replaceAll('let ', 'let~')
    .replaceAll('var ', 'var~')
    .replaceAll('class ', 'class~')
    .replace(/get [^=}]/g, _ => _.replaceAll(' ', '~'))
    .replaceAll('delete ', 'delete~')
    .replaceAll(' extends ', '~extends~')
    .replaceAll('typeof ', 'typeof~')
    .replaceAll(' of ', '~of~')
    .replaceAll(' in ', '~in~')
    .replaceAll('case ', 'case~')
    .replaceAll('await ', 'await~')
    .replaceAll('new ', 'new~')
    .replaceAll('return ', 'return~')
    .replaceAll('function ', 'function~')
    .replaceAll('void ', 'void~')
    .replaceAll('throw ', 'throw~')
    .replaceAll('async ', 'async~')
    .replaceAll('else ', 'else~')
    .replace('/([0-9]+) files/', '/([0-9]+)~files/')
    // .replaceAll('false', '!1')
    // .replaceAll('true', '!0')
    .replace(/((['"`])[\s\S]*?\2)|[ \n]/g, (_, g1) => g1 || '')
    .replaceAll('~', ' ')
    .replaceAll('? ?', '??');

  return protectedTemplates.restore(stripped);
};

const fixHtml = (code) => code
  .replaceAll(' loop', '~loop')
  .replaceAll(' autoplay', '~autoplay')
  .replaceAll(' src', '~src')
  .replaceAll(' id', '~id');

const stripJs = (path) => writeFileSync(path, stripCode(readFileSync(path, 'utf8')));
const stripHtml = (path) => writeFileSync(path, stripCode(fixHtml(readFileSync(path, 'utf8'))));

const minJson = (data) => {
  if (data.description) delete data.description;

  return data;
};

const stripJson = (path) => writeFileSync(path, JSON.stringify(minJson(JSON.parse(readFileSync(path, 'utf8')))));

const tree = (dirPath) => readdirSync(dirPath).forEach((x) => {
  const path = join(dirPath, x);
  console.log(path);

  if (x.endsWith('.js')) return stripJs(path);
  if (x.endsWith('.json')) return stripJson(path);
  if (x.endsWith('.html')) return stripHtml(path);
  if (!x.includes('.')) return tree(path);
});

tree(join(__dirname, '..', 'src'));
