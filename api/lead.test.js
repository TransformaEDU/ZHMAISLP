/**
 * Teste da rota de lead, sem framework e sem rede.
 * Rodar:  node api/lead.test.js
 *
 * O que importa aqui é a barreira de confiança: o navegador pode ser
 * adulterado, então a rota precisa recusar sozinha combinação de unidade e
 * turma que não existe, e nunca responder sucesso sem gravar o contato.
 */

'use strict';
const assert = require('assert');

const BASE = { AC_API_URL: 'https://teste.api-us1.com', AC_API_KEY: 'chave-de-teste' };
const TL = { TECHLITHY_ACCOUNT_ID: 'c72973c2-0000-0000-0000-000000000000', TECHLITHY_API_TOKEN: 'lsk_teste' };
const AMBOS = { ...BASE, ...TL };

/* Espelha o que a página manda hoje. "origem" e "colegio" saíram do formulário
   por decisão da direção, então não aparecem aqui, mas o servidor continua
   aceitando os dois para quando forem reativados. */
const leadValido = {
  unidade: 'Icaraí',
  turma: 'Infantil N3',
  candidato: 'Maria Clara Souza',
  responsavel: 'Ana Paula Souza',
  whatsapp: '(21) 96925-2117',
  email: 'ana@exemplo.com',
  consentimento: true,
};

function resFalso() {
  const r = { code: 0, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}

/* Substitui a rede por respostas fixas e registra o que foi chamado. */
function mockarFetch(chamadas, { syncOk = true, listaOk = true, tlOk = true } = {}) {
  global.fetch = async (url, opts) => {
    chamadas.push({ url: String(url), metodo: opts.method, headers: opts.headers, corpo: opts.body ? JSON.parse(opts.body) : null });
    const resp = (ok, obj) => ({ ok, status: ok ? 200 : 500, text: async () => JSON.stringify(obj) });
    if (String(url).includes('crm.techlithy.com')) return resp(tlOk, { ok: tlOk });
    if (String(url).includes('/contact/sync')) return resp(syncOk, { contact: { id: '999' } });
    if (String(url).includes('/contactLists')) return resp(listaOk, { contactList: { id: '1' } });
    if (String(url).includes('/api/3/tags?')) return resp(true, { tags: [{ id: '4242', tag: 'LP Infantil ao 5º Ano - ZH+ 2027' }] });
    if (String(url).includes('/contactTags')) return resp(true, { contactTag: { id: '2' } });
    return resp(true, {});
  };
}

async function executar(body, env = BASE, opts = {}) {
  for (const k of Object.keys(process.env)) if (k.startsWith('AC_') || k.startsWith('TECHLITHY_')) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('./lead.js')];
  const handler = require('./lead.js');
  const chamadas = [];
  mockarFetch(chamadas, opts);
  const res = resFalso();
  await handler({ method: 'POST', body }, res);
  return { res, chamadas };
}

(async () => {
  {
    const { res, chamadas } = await executar(leadValido);
    assert.strictEqual(res.code, 200, 'lead válido deveria retornar 200');
    assert.strictEqual(res.body.ok, true);
    const sync = chamadas.find((c) => c.url.includes('/contact/sync'));
    const campos = Object.fromEntries(sync.corpo.contact.fieldValues.map((f) => [f.field, f.value]));
    assert.strictEqual(campos['1'], 'Icaraí', 'campo 1 deve levar a unidade');
    assert.strictEqual(campos['12'], 'Infantil N3', 'campo 12 deve levar a turma');
    assert.strictEqual(campos['72'], 'Maria Clara Souza', 'campo 72 deve levar o nome do aluno');
    assert.strictEqual(campos['46'], 'Infantil', 'segmento deve sair de Infantil');
    assert.ok(!('23' in campos), 'campo 23 não pode ir: a pergunta saiu do formulário');
    assert.ok(!('8' in campos), 'campo 8 não pode ir: a pergunta saiu do formulário');
    assert.strictEqual(sync.corpo.contact.firstName, 'Ana');
    assert.strictEqual(sync.corpo.contact.lastName, 'Paula Souza');
    const lista = chamadas.find((c) => c.url.includes('/contactLists'));
    assert.strictEqual(lista.corpo.contactList.list, 78, 'deve entrar na lista Formulários 2027');
    assert.ok(chamadas.some((c) => c.url.includes('/contactTags')), 'deve aplicar a tag');
    console.log('ok  lead válido grava contato, lista e tag');
  }

  {
    /* O ponto central: Educação Infantil não existe no Méier. */
    const { res, chamadas } = await executar({ ...leadValido, unidade: 'Méier' });
    assert.strictEqual(res.code, 400, 'combinação inexistente deveria ser recusada');
    assert.match(res.body.erro, /turma não é oferecida/i);
    assert.strictEqual(chamadas.length, 0, 'não pode chamar o ActiveCampaign com dado inválido');
    console.log('ok  Infantil no Méier é recusado antes de tocar o CRM');
  }

  {
    const { res } = await executar({ ...leadValido, unidade: 'Vila Isabel', turma: '5º Ano - Especializado' });
    assert.strictEqual(res.code, 400, '5º Especializado só existe no Méier');
    console.log('ok  5º Especializado fora do Méier é recusado');
  }

  {
    const { res } = await executar({ ...leadValido, unidade: 'Méier', turma: '5º Ano - Especializado' });
    assert.strictEqual(res.code, 200, '5º Especializado no Méier é válido');
    console.log('ok  5º Especializado no Méier é aceito');
  }

  {
    const { res, chamadas } = await executar({ ...leadValido, website: 'http://spam.example' });
    assert.strictEqual(res.code, 200, 'robô recebe 200 para não perceber o bloqueio');
    assert.strictEqual(chamadas.length, 0, 'isca preenchida não pode gerar lead');
    console.log('ok  isca anti-robô descarta sem gravar');
  }

  {
    const { res } = await executar({ ...leadValido, consentimento: false });
    assert.strictEqual(res.code, 400, 'sem consentimento não grava');
    console.log('ok  sem consentimento é recusado');
  }

  {
    const { res } = await executar(leadValido, {});
    assert.strictEqual(res.code, 503, 'sem env a integração responde 503');
    console.log('ok  falta de variável de ambiente vira 503, não 500');
  }

  {
    const { res, chamadas } = await executar({ ...leadValido, colegio: '', origem: '' });
    assert.strictEqual(res.code, 200, 'campos desativados vazios não podem barrar o cadastro');
    const sync = chamadas.find((c) => c.url.includes('/contact/sync'));
    const campos = Object.fromEntries(sync.corpo.contact.fieldValues.map((f) => [f.field, f.value]));
    assert.ok(!('8' in campos) && !('23' in campos), 'vazio não pode ir e apagar o que já existia no contato');
    console.log('ok  campos desativados vazios não apagam valor antigo do contato');
  }

  {
    /* Caminho de volta: se a direção reativar as perguntas, o servidor já grava. */
    const { res, chamadas } = await executar({ ...leadValido, origem: 'Particular', colegio: 'Escola Girassol' });
    assert.strictEqual(res.code, 200);
    const sync = chamadas.find((c) => c.url.includes('/contact/sync'));
    const campos = Object.fromEntries(sync.corpo.contact.fieldValues.map((f) => [f.field, f.value]));
    assert.strictEqual(campos['23'], 'Particular', 'origem escolar volta a ser gravada se vier');
    assert.strictEqual(campos['8'], 'Escola Girassol', 'colégio atual volta a ser gravado se vier');
    console.log('ok  origem e colégio continuam suportados para quando voltarem');
  }

  {
    const { res } = await executar({ ...leadValido, origem: 'Semi-particular' });
    assert.strictEqual(res.code, 400, 'origem fora da lista continua recusada');
    console.log('ok  origem escolar inválida é recusada');
  }

  {
    const { res } = await executar({ ...leadValido, email: 'invalido@' });
    assert.strictEqual(res.code, 400);
    console.log('ok  e-mail inválido é recusado');
  }

  {
    const { res } = await executar({ ...leadValido, whatsapp: '999' });
    assert.strictEqual(res.code, 400);
    console.log('ok  telefone curto é recusado');
  }

  {
    /* Se a lista falha, a automação não dispara: melhor o pai tentar de novo
       do que o lead sumir achando que deu certo. */
    const { res } = await executar(leadValido, BASE, { listaOk: false });
    assert.strictEqual(res.code, 502, 'falha ao inscrever na lista não pode virar sucesso');
    console.log('ok  falha na lista devolve 502, nunca sucesso falso');
  }

  /* ------------------------------------------------------ TechLithy --- */

  {
    const { res, chamadas } = await executar({ ...leadValido, utm: { utm_source: 'instagram', utm_campaign: 'matriculas' } }, AMBOS);
    assert.strictEqual(res.code, 200);
    const tl = chamadas.find((c) => c.url.includes('crm.techlithy.com'));
    assert.ok(tl, 'deve chamar o webhook do TechLithy');
    const u = new URL(tl.url);
    assert.strictEqual(u.pathname, '/webhook/lead-intake/' + TL.TECHLITHY_ACCOUNT_ID, 'uuid da conta vai no caminho');
    assert.strictEqual(u.searchParams.get('utm_source'), 'instagram', 'utm_source vai na query');
    assert.ok(!('utm_source' in tl.corpo), 'utm_source não pode ir no corpo');
    assert.strictEqual(tl.headers.Authorization, 'Bearer lsk_teste');
    assert.strictEqual(tl.headers['Content-Type'], 'application/json');
    assert.strictEqual(tl.headers.Origin, 'https://infantil.zhmais.com.br', 'CRM confere a origem');
    assert.strictEqual(tl.corpo['form-field-name'], 'Ana Paula Souza', 'Nome = responsável');
    assert.strictEqual(tl.corpo['form-field-email'], 'ana@exemplo.com');
    assert.strictEqual(tl.corpo['form-field-field_b9d9940'], '+55 21 96925-2117', 'Telefone');
    assert.strictEqual(tl.corpo['form-field-field_f7903d6'], 'Icaraí', 'Unidade');
    assert.deepStrictEqual(tl.corpo['form-field-field_009575c'], ['Infantil N3'], 'Turma vai como array');
    assert.strictEqual(tl.corpo['form-field-field_0d0c50e'], 'Maria Clara Souza', 'Aluno');
    assert.match(tl.corpo.external_id, /^lp-infantil-zhmais-2027-[0-9a-f-]{36}$/);
    assert.ok(chamadas.some((c) => c.url.includes('/contact/sync')), 'AC continua recebendo');
    console.log('ok  TechLithy recebe o lead no contrato do guia, junto com o AC');
  }

  {
    const a = await executar(leadValido, AMBOS);
    const b = await executar(leadValido, AMBOS);
    const id = (r) => r.chamadas.find((c) => c.url.includes('crm.techlithy.com')).corpo.external_id;
    assert.notStrictEqual(id(a), id(b), 'external_id precisa ser único por envio');
    console.log('ok  external_id é único a cada envio');
  }

  {
    const { res } = await executar(leadValido, AMBOS, { syncOk: false });
    assert.strictEqual(res.code, 200, 'AC fora e TechLithy ok: o lead não se perde');
    console.log('ok  AC falhando não derruba o TechLithy');
  }

  {
    const { res } = await executar(leadValido, AMBOS, { tlOk: false });
    assert.strictEqual(res.code, 200, 'TechLithy fora e AC ok: o lead não se perde');
    console.log('ok  TechLithy falhando não derruba o AC');
  }

  {
    const { res } = await executar(leadValido, AMBOS, { syncOk: false, tlOk: false });
    assert.strictEqual(res.code, 502, 'os dois fora: nunca sucesso falso');
    console.log('ok  os dois CRMs falhando devolve 502');
  }

  {
    const { res, chamadas } = await executar(leadValido, TL);
    assert.strictEqual(res.code, 200);
    assert.ok(chamadas.every((c) => c.url.includes('crm.techlithy.com')), 'sem env do AC, só o TechLithy é chamado');
    console.log('ok  só com as variáveis do TechLithy a rota funciona');
  }

  {
    const { chamadas } = await executar(leadValido, AMBOS);
    const tl = chamadas.find((c) => c.url.includes('crm.techlithy.com'));
    assert.ok(!new URL(tl.url).search, 'sem UTM, a URL vai sem query');
    console.log('ok  sem UTM a URL do webhook vai limpa');
  }

  console.log('\ntodos os testes passaram');
})().catch((e) => { console.error('\nFALHOU:', e.message); process.exit(1); });
