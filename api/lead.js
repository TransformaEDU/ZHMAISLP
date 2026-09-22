/**
 * Recebe o cadastro da landing page e grava o lead em dois CRMs, em paralelo:
 * ActiveCampaign e TechLithy CRM.
 *
 * As chaves nunca chegam ao navegador: vivem nas variáveis de ambiente da
 * Vercel e só são lidas aqui, no servidor (opção 1 do guia do TechLithy).
 *
 * Variáveis (Vercel > Settings > Environment Variables):
 *   AC_API_URL            ex.: https://suaconta.api-us1.com
 *   AC_API_KEY            chave do AC, marcada como Sensitive
 *   TECHLITHY_ACCOUNT_ID  uuid da conta; compõe a URL do webhook de lead intake
 *   TECHLITHY_API_TOKEN   Bearer token lsk_..., marcado como Sensitive
 * Cada CRM só é chamado se as variáveis dele existirem.
 *
 * Convenção de status:
 *   200  lead gravado em pelo menos um CRM
 *   400  payload inválido (campo faltando, combinação inexistente)
 *   405  método errado
 *   502  nenhum CRM aceitou o lead
 *   503  nenhuma integração configurada (falta env)
 */

'use strict';

const { randomUUID } = require('crypto');

/* Identificadores dos campos personalizados, conferidos na conta em 22/09/2026. */
const CAMPO = {
  unidade:     1,   // Unidade (de interesse)
  turma:       12,  // Turma (de interesse)
  aluno:       72,  // Nome do aluno
  origem:      23,  // O candidato vem de escola (desativado na página)
  colegio:     8,   // Colégio atual (desativado na página)
  responsavel: 7,   // Nome completo do Responsável
  fonte:       3,   // Fonte de cadastro
  segmento:    46,  // Segmento
  campanha:    53,  // Campanha
  utmSource:   58,  // Utm Source
  lastSource:  82,
  lastMedium:  83,
  lastCampaign:84,
  lastContent: 85,
  lastTerm:    86,
  lastFbclid:  87,
  lastGclid:   88,
};

const LISTA_ID = 78;                                  // Formulários 2027
const TAG_NOME = 'LP Infantil ao 5º Ano - ZH+ 2027';
const FONTE    = 'Formulário - Externo';
const CAMPANHA = 'Infantil / Fund 1';

/* Oferta real por unidade. Espelha a planilha oficial de turmas e existe para
   que um cliente adulterado não consiga injetar combinação inexistente no CRM:
   a Educação Infantil só existe em Icaraí, e o 5º Especializado só no Méier. */
const FUND1 = [
  '1º Ano - Ensino Fundamental Anos Iniciais',
  '2º Ano - Ensino Fundamental Anos Iniciais',
  '3º Ano - Ensino Fundamental Anos Iniciais',
  '4º Ano - Ensino Fundamental Anos Iniciais',
  '5º Ano - Ensino Fundamental Anos Iniciais',
];
const TURMAS_POR_UNIDADE = {
  'Icaraí':      ['Infantil N1', 'Infantil N2', 'Infantil N3', 'Infantil N4', 'Infantil N5', ...FUND1],
  'Méier':       [...FUND1, '5º Ano - Especializado'],
  'Vila Isabel': [...FUND1],
};

/* "O candidato vem de escola" e "Colégio atual" saíram do formulário por
   decisão da direção (22/09/2026). O suporte continua aqui e os dois campos
   são aceitos se vierem: reativar é devolver a seção correspondente ao
   index.html, nada mais. Enquanto não vierem, os campos 23 e 8 simplesmente
   não são enviados ao ActiveCampaign. */
const ORIGENS = ['Particular', 'Pública', 'Não Estuda'];

const texto = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

function validar(body) {
  const d = {
    unidade:     texto(body.unidade, 60),
    turma:       texto(body.turma, 80),
    candidato:   texto(body.candidato, 120),
    origem:      texto(body.origem, 30),
    colegio:     texto(body.colegio, 120),
    responsavel: texto(body.responsavel, 120),
    whatsapp:    texto(body.whatsapp, 30),
    email:       texto(body.email, 160).toLowerCase(),
  };

  const turmas = TURMAS_POR_UNIDADE[d.unidade];
  if (!turmas) return { erro: 'Unidade inválida.' };
  if (!turmas.includes(d.turma)) return { erro: 'Essa turma não é oferecida na unidade escolhida.' };
  if (d.origem && !ORIGENS.includes(d.origem)) return { erro: 'Origem escolar inválida.' };
  if (d.candidato.length < 5 || !d.candidato.includes(' ')) return { erro: 'Informe o nome completo do candidato.' };
  if (d.responsavel.length < 5 || !d.responsavel.includes(' ')) return { erro: 'Informe o nome completo do responsável.' };
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(d.email)) return { erro: 'E-mail inválido.' };

  const digitos = d.whatsapp.replace(/\D/g, '');
  if (digitos.length < 10 || digitos.length > 11) return { erro: 'WhatsApp inválido. Informe DDD e número.' };

  if (d.origem === 'Não Estuda') d.colegio = '';

  return { dados: d, digitos };
}

/* O AC responde em ms no caminho feliz, mas uma chamada pendurada seguraria a
   função até o limite dela. Abortamos antes disso para devolver erro limpo. */
async function chamarAC(caminho, { metodo = 'GET', corpo, base, chave, ms = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(base.replace(/\/+$/, '') + caminho, {
      method: metodo,
      headers: { 'Api-Token': chave, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: ctrl.signal,
    });
    const txt = await r.text();
    let json = null;
    try { json = txt ? JSON.parse(txt) : null; } catch { /* resposta não-JSON */ }
    return { ok: r.ok, status: r.status, json, txt };
  } finally {
    clearTimeout(timer);
  }
}

/* A tag é resolvida por nome e criada na primeira vez. Guardamos o id em escopo
   de módulo para não repetir a busca a cada lead enquanto a instância vive. */
let tagIdCache = null;
async function obterTagId(base, chave) {
  if (tagIdCache) return tagIdCache;

  const busca = await chamarAC('/api/3/tags?filters[tag]=' + encodeURIComponent(TAG_NOME) + '&limit=100', { base, chave });
  const achada = busca.ok && Array.isArray(busca.json?.tags)
    ? busca.json.tags.find((t) => t.tag === TAG_NOME)
    : null;
  if (achada) { tagIdCache = achada.id; return tagIdCache; }

  const criada = await chamarAC('/api/3/tags', {
    metodo: 'POST', base, chave,
    corpo: { tag: { tag: TAG_NOME, tagType: 'contact', description: 'Leads da landing page infantil.zhmais.com.br' } },
  });
  if (criada.ok && criada.json?.tag?.id) { tagIdCache = criada.json.tag.id; return tagIdCache; }
  return null;
}

/* Formata o WhatsApp para gravação: (21) 99999-9999 */
function telefoneFormatado(digitos) {
  return digitos.length === 11
    ? `(${digitos.slice(0, 2)}) ${digitos.slice(2, 7)}-${digitos.slice(7)}`
    : `(${digitos.slice(0, 2)}) ${digitos.slice(2, 6)}-${digitos.slice(6)}`;
}

/* ---------------------------------------------------------------- AC --- */

/* Devolve true se o lead ficou gravado e inscrito na lista. Nunca lança. */
async function enviarAC({ dados, digitos, utm, base, chave }) {
  const partes = dados.responsavel.split(' ');
  const campo = (id, value) => ({ field: String(id), value: value || '' });

  const fieldValues = [
    campo(CAMPO.unidade, dados.unidade),
    campo(CAMPO.turma, dados.turma),
    campo(CAMPO.aluno, dados.candidato),
    campo(CAMPO.responsavel, dados.responsavel),
    campo(CAMPO.fonte, FONTE),
    campo(CAMPO.campanha, CAMPANHA),
    campo(CAMPO.segmento, dados.turma.startsWith('Infantil') ? 'Infantil' : 'Fundamental 1'),
  ];

  /* Campos opcionais entram só quando vêm preenchidos. Mandar string vazia
     apagaria o que já estivesse gravado num contato que voltou a se cadastrar. */
  if (dados.origem) fieldValues.push(campo(CAMPO.origem, dados.origem));
  if (dados.colegio) fieldValues.push(campo(CAMPO.colegio, dados.colegio));

  /* Só gravamos os UTM de última origem. Os "first_" ficam intocados para não
     apagar o primeiro contato de quem já existia na base. */
  const utms = [
    [CAMPO.utmSource, utm.utm_source], [CAMPO.lastSource, utm.utm_source],
    [CAMPO.lastMedium, utm.utm_medium], [CAMPO.lastCampaign, utm.utm_campaign],
    [CAMPO.lastContent, utm.utm_content], [CAMPO.lastTerm, utm.utm_term],
    [CAMPO.lastFbclid, utm.fbclid], [CAMPO.lastGclid, utm.gclid],
  ];
  for (const [id, valor] of utms) {
    const v = texto(valor, 200);
    if (v) fieldValues.push(campo(id, v));
  }

  try {
    const sync = await chamarAC('/api/3/contact/sync', {
      metodo: 'POST', base, chave,
      corpo: {
        contact: {
          email: dados.email,
          firstName: partes[0],
          lastName: partes.slice(1).join(' '),
          phone: telefoneFormatado(digitos),
          fieldValues,
        },
      },
    });

    const contatoId = sync.json?.contact?.id;
    if (!sync.ok || !contatoId) {
      console.error('[lead:ac] contact/sync falhou', sync.status, sync.txt?.slice(0, 400));
      return false;
    }

    /* A lista é o que importa para as automações, então o erro dela é fatal.
       A tag é rastreamento: se falhar, o lead não se perde por causa disso. */
    const lista = await chamarAC('/api/3/contactLists', {
      metodo: 'POST', base, chave,
      corpo: { contactList: { list: LISTA_ID, contact: contatoId, status: 1 } },
    });
    if (!lista.ok) {
      console.error('[lead:ac] contactLists falhou', lista.status, lista.txt?.slice(0, 400));
      return false;
    }

    try {
      const tagId = await obterTagId(base, chave);
      if (tagId) {
        await chamarAC('/api/3/contactTags', {
          metodo: 'POST', base, chave,
          corpo: { contactTag: { contact: contatoId, tag: tagId } },
        });
      }
    } catch (e) {
      console.error('[lead:ac] tag nao aplicada', e?.message);
    }

    console.log('[lead:ac] ok', { contato: contatoId });
    return true;
  } catch (e) {
    console.error('[lead:ac] erro inesperado', e?.name === 'AbortError' ? 'timeout' : e?.message);
    return false;
  }
}

/* --------------------------------------------------------- TechLithy --- */

/* Contrato do webhook (Guia de integração de formulários do TechLithy CRM):
   - POST https://crm.techlithy.com/webhook/lead-intake/<uuid-da-conta>
   - Authorization: Bearer lsk_...  +  Content-Type: application/json
   - utm_source vai na QUERY da URL, não no corpo
   - external_id único por envio, com prefixo que identifica o formulário

   As chaves abaixo são as do "Mapeamento de campos" já configurado no CRM
   para o formulário ZeroHum (tabela da seção 1.1 do guia). Chave que não
   está no mapeamento chega ao CRM mas se perde sem erro, então não mandamos
   nada além delas.

   O CRM também confere o cabeçalho Origin contra as origens autorizadas da
   fonte de leads: origem fora da lista devolve 403
   ORIGEM_NAO_AUTORIZADA_PARA_ESTA_FONTE_DE_LEADS. */
const TL_BASE = 'https://crm.techlithy.com/webhook/lead-intake/';
const TL_PREFIXO = 'lp-infantil-zhmais-2027-';
const TL_ORIGEM = 'https://infantil.zhmais.com.br';

function payloadTechLithy({ dados, digitos }) {
  const p = {
    'form-field-name':          dados.candidato,        // Aluno
    'form-field-email':         dados.email,            // E-mail
    'form-field-message':       '+55 ' + telefoneFormatado(digitos).replace(/[()]/g, ''), // Telefone
    'form-field-field_0a78d11': [dados.turma],          // Turma (array)
    'form-field-field_924fc50': dados.unidade,          // Unidade
    'form-field-field_bff5e55': dados.responsavel,      // Nome (responsável)
  };
  if (dados.origem) p['form-field-field_95cab32'] = dados.origem;   // Vem de escola
  if (dados.colegio) p['form-field-field_85f402d'] = dados.colegio; // Colégio atual
  p.external_id = TL_PREFIXO + randomUUID();
  return p;
}

/* Devolve true se o CRM respondeu 2xx. Nunca lança. */
async function enviarTechLithy({ dados, digitos, utm, conta, token, ms = 8000 }) {
  const url = new URL(TL_BASE + encodeURIComponent(conta));
  const origem = texto(utm.utm_source, 200);
  if (origem) url.searchParams.set('utm_source', origem);

  const corpo = payloadTechLithy({ dados, digitos });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json',
        Origin: TL_ORIGEM,
      },
      body: JSON.stringify(corpo),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error('[lead:techlithy] webhook recusou', r.status, txt.slice(0, 400));
      return false;
    }
    console.log('[lead:techlithy] ok', { external_id: corpo.external_id });
    return true;
  } catch (e) {
    console.error('[lead:techlithy] erro', e?.name === 'AbortError' ? 'timeout' : e?.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------------------------------------- handler --- */

module.exports = async function handler(req, res) {
  const base = process.env.AC_API_URL;
  const chave = process.env.AC_API_KEY;
  const tlConta = process.env.TECHLITHY_ACCOUNT_ID;
  const tlToken = process.env.TECHLITHY_API_TOKEN;
  const temAC = Boolean(base && chave);
  const temTL = Boolean(tlConta && tlToken);

  /* Houve aqui um GET ?check=1 que autenticava no ActiveCampaign para conferir
     a credencial. Removido: sendo público e sem autenticação, qualquer um podia
     dispará-lo em massa, consumir o limite de requisições da conta no AC e
     derrubar o envio de leads de verdade. Para reconferir a chave depois de
     rotacionar, envie um cadastro pelo próprio formulário. */

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, erro: 'Método não permitido.' });
  }

  if (!temAC && !temTL) {
    console.error('[lead] nenhuma integração configurada (AC_* e TECHLITHY_* ausentes)');
    return res.status(503).json({ ok: false, erro: 'Integração indisponível no momento.' });
  }
  if (!temAC) console.warn('[lead] AC_API_URL ou AC_API_KEY ausente: ActiveCampaign ignorado');
  if (!temTL) console.warn('[lead] TECHLITHY_ACCOUNT_ID ou TECHLITHY_API_TOKEN ausente: TechLithy ignorado');

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ ok: false, erro: 'Requisição inválida.' });

  /* Campo isca: fica escondido no formulário, então só robô preenche.
     Respondemos 200 de propósito, para o robô não descobrir que foi barrado. */
  if (texto(body.website, 200)) return res.status(200).json({ ok: true });

  if (body.consentimento !== true) return res.status(400).json({ ok: false, erro: 'É necessário autorizar o contato.' });

  const { erro, dados, digitos } = validar(body);
  if (erro) return res.status(400).json({ ok: false, erro });

  const utm = body.utm && typeof body.utm === 'object' ? body.utm : {};

  /* Os dois CRMs rodam em paralelo e um não derruba o outro. O visitante vê
     sucesso se pelo menos um gravou: a falha do outro fica no log da Vercel
     (procure por [lead:ac] ou [lead:techlithy]). */
  const [okAC, okTL] = await Promise.all([
    temAC ? enviarAC({ dados, digitos, utm, base, chave }) : Promise.resolve(null),
    temTL ? enviarTechLithy({ dados, digitos, utm, conta: tlConta, token: tlToken }) : Promise.resolve(null),
  ]);

  console.log('[lead]', { ac: okAC, techlithy: okTL, unidade: dados.unidade, turma: dados.turma, origem: body.origemPagina || '-' });

  if (okAC || okTL) return res.status(200).json({ ok: true });
  return res.status(502).json({ ok: false, erro: 'Não foi possível concluir agora. Tente novamente em instantes.' });
};
