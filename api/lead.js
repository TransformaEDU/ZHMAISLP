/**
 * Recebe o cadastro da landing page e grava o lead no ActiveCampaign.
 *
 * A chave da API nunca chega ao navegador: ela vive nas variáveis de ambiente
 * da Vercel e só é lida aqui, no servidor.
 *
 * Variáveis necessárias (Vercel > Settings > Environment Variables):
 *   AC_API_URL  ex.: https://suaconta.api-us1.com   (Settings > Developer no AC)
 *   AC_API_KEY  a chave da mesma tela, marcada como Sensitive
 *
 * Convenção de status:
 *   200  lead gravado
 *   400  payload inválido (campo faltando, combinação inexistente)
 *   405  método errado
 *   502  o ActiveCampaign recusou ou ficou fora do ar
 *   503  a integração não está configurada (falta env)
 */

'use strict';

/* Identificadores dos campos personalizados, conferidos na conta em 22/09/2026. */
const CAMPO = {
  unidade:     1,   // Unidade (de interesse)
  turma:       12,  // Turma (de interesse)
  aluno:       72,  // Nome do aluno
  origem:      23,  // O candidato vem de escola
  colegio:     8,   // Colégio atual
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
  if (!ORIGENS.includes(d.origem)) return { erro: 'Origem escolar inválida.' };
  if (d.candidato.length < 5 || !d.candidato.includes(' ')) return { erro: 'Informe o nome completo do candidato.' };
  if (d.responsavel.length < 5 || !d.responsavel.includes(' ')) return { erro: 'Informe o nome completo do responsável.' };
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(d.email)) return { erro: 'E-mail inválido.' };

  const digitos = d.whatsapp.replace(/\D/g, '');
  if (digitos.length < 10 || digitos.length > 11) return { erro: 'WhatsApp inválido. Informe DDD e número.' };

  /* "Não Estuda" dispensa o colégio atual; nos outros casos ele é obrigatório. */
  if (d.origem !== 'Não Estuda' && d.colegio.length < 2) return { erro: 'Informe o colégio atual.' };
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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, erro: 'Método não permitido.' });
  }

  const base = process.env.AC_API_URL;
  const chave = process.env.AC_API_KEY;
  if (!base || !chave) {
    console.error('[lead] AC_API_URL ou AC_API_KEY ausente no ambiente');
    return res.status(503).json({ ok: false, erro: 'Integração indisponível no momento.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ ok: false, erro: 'Requisição inválida.' });

  /* Campo isca: fica escondido no formulário, então só robô preenche.
     Respondemos 200 de propósito, para o robô não descobrir que foi barrado. */
  if (texto(body.website, 200)) return res.status(200).json({ ok: true });

  if (body.consentimento !== true) return res.status(400).json({ ok: false, erro: 'É necessário autorizar o contato.' });

  const { erro, dados, digitos } = validar(body);
  if (erro) return res.status(400).json({ ok: false, erro });

  const partes = dados.responsavel.split(' ');
  const utm = body.utm && typeof body.utm === 'object' ? body.utm : {};
  const campo = (id, value) => ({ field: String(id), value: value || '' });

  const fieldValues = [
    campo(CAMPO.unidade, dados.unidade),
    campo(CAMPO.turma, dados.turma),
    campo(CAMPO.aluno, dados.candidato),
    campo(CAMPO.origem, dados.origem),
    campo(CAMPO.colegio, dados.colegio),
    campo(CAMPO.responsavel, dados.responsavel),
    campo(CAMPO.fonte, FONTE),
    campo(CAMPO.campanha, CAMPANHA),
    campo(CAMPO.segmento, dados.turma.startsWith('Infantil') ? 'Infantil' : 'Fundamental 1'),
  ];

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
          phone: digitos.length === 11
            ? `(${digitos.slice(0, 2)}) ${digitos.slice(2, 7)}-${digitos.slice(7)}`
            : `(${digitos.slice(0, 2)}) ${digitos.slice(2, 6)}-${digitos.slice(6)}`,
          fieldValues,
        },
      },
    });

    const contatoId = sync.json?.contact?.id;
    if (!sync.ok || !contatoId) {
      console.error('[lead] contact/sync falhou', sync.status, sync.txt?.slice(0, 400));
      return res.status(502).json({ ok: false, erro: 'Não foi possível concluir agora. Tente novamente em instantes.' });
    }

    /* A lista é o que importa para as automações, então o erro dela é fatal.
       A tag é rastreamento: se falhar, o lead não se perde por causa disso. */
    const lista = await chamarAC('/api/3/contactLists', {
      metodo: 'POST', base, chave,
      corpo: { contactList: { list: LISTA_ID, contact: contatoId, status: 1 } },
    });
    if (!lista.ok) {
      console.error('[lead] contactLists falhou', lista.status, lista.txt?.slice(0, 400));
      return res.status(502).json({ ok: false, erro: 'Não foi possível concluir agora. Tente novamente em instantes.' });
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
      console.error('[lead] tag nao aplicada', e?.message);
    }

    console.log('[lead] ok', { contato: contatoId, unidade: dados.unidade, turma: dados.turma, origem: body.origemPagina || '-' });
    return res.status(200).json({ ok: true });
  } catch (e) {
    const abortado = e?.name === 'AbortError';
    console.error('[lead] erro inesperado', abortado ? 'timeout no ActiveCampaign' : e?.message);
    return res.status(502).json({ ok: false, erro: 'Não foi possível concluir agora. Tente novamente em instantes.' });
  }
};
