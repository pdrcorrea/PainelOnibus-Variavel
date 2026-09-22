# PontoView Bus API

Pequeno backend em Cloudflare Workers para o painel de horários de ônibus.

## O que ele faz

- esconde a chave do Google Maps do navegador;
- geocodifica o endereço do ponto no servidor;
- faz a mesma varredura de 12 direções usada pelo painel atual;
- normaliza as viagens em um JSON simples para o frontend;
- mantém o resultado fresco por 10 minutos;
- mantém uma cópia por até 1 hora para fallback;
- reaproveita a geocodificação por 7 dias;
- remove horários que já passaram mesmo quando a resposta vem do cache.

## APIs do Google necessárias

Ative no mesmo projeto do Google Cloud:

- Geocoding API
- Directions API (Legacy)

A chave do backend deve ficar restrita somente a essas APIs.

> Como a chamada parte do Cloudflare Worker, não use restrição por HTTP Referrer nessa chave de backend.

## Deploy rápido

Dentro da pasta `worker`:

```bash
npm install
npx wrangler login
npx wrangler secret put GOOGLE_MAPS_API_KEY
npm run deploy
```

O Wrangler solicitará a chave de API sem gravá-la no repositório.

Após o deploy, teste:

```text
https://SEU-WORKER.workers.dev/health
```

Depois:

```text
https://SEU-WORKER.workers.dev/api/bus
```

Também é possível escolher outro ponto:

```text
https://SEU-WORKER.workers.dev/api/bus?station=Praça%20Municipal%20de%20Colatina
```

## Cache

O JSON traz:

```json
{
  "cache": {
    "status": "HIT",
    "ageSeconds": 42,
    "freshForSeconds": 558
  }
}
```

Estados:

- `MISS`: foi necessário consultar o Google;
- `HIT`: resposta servida do cache;
- `STALE`: Google falhou e a última cópia disponível foi usada.

O header `X-PontoView-Cache` também informa o estado.

## Próxima etapa

Depois de publicar o Worker, o `index.html` do painel pode deixar de carregar a Google Maps JavaScript API e passar a chamar apenas:

```js
fetch("https://SEU-WORKER.workers.dev/api/bus?station=" + encodeURIComponent(station))
```

Isso remove a chave do frontend e faz várias TVs compartilharem o mesmo cache no ponto de presença da Cloudflare.
