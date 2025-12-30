/* pv-footer.js — Rodapé unificado PontoView (v2)
   - Prioriza rodapé dentro do painel: .panelFooter .pvFooter
   - Não altera altura do layout (sem padding/borda aqui)
   - Day/Night + animação sutil
*/
(function () {
  const LOGO = "./assets/logo-pontoview.png"; // ajuste se necessário

  const css = `
    .pvFooter{
      display:flex;
      align-items:center;
      justify-content:flex-end; /* direita por padrão */
      background: transparent;
      min-height: 0; /* não força altura */
    }

    .pvFooterBrand{
      display:flex;
      align-items:center;
    }

    .pvFooterBrand img{
      height:18px; /* menor para caber no card */
      width:auto;
      transition: opacity .35s ease, transform .35s ease;
      display:block;
    }

    /* animação sutil de entrada */
    .pvEnter{
      animation: pvEnter .35s ease-out both;
    }
    @keyframes pvEnter{
      from{ opacity:0; transform: translateY(6px); }
      to{ opacity:1; transform:none; }
    }

    /* telas menores: centraliza */
    @media (max-width: 900px){
      .pvFooter{ justify-content:center; }
    }

    @media (prefers-reduced-motion: reduce){
      .pvEnter{ animation:none !important; }
    }
  `;

  function isNight(){
    const h = new Date().getHours();
    return h >= 19 || h < 7;
  }

  function applyOpacity(img){
    if (!img) return;
    img.style.opacity = isNight() ? "0.60" : "0.90";
  }

  // injeta CSS uma vez
  if (!document.getElementById("pvFooterStyles")) {
    const style = document.createElement("style");
    style.id = "pvFooterStyles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ✅ prioridade: dentro do card branco
  let footer =
    document.querySelector(".panelFooter .pvFooter") ||
    document.querySelector(".pvFooter");

  // fallback: cria no body (só se realmente não existir mount)
  if (!footer) {
    footer = document.createElement("div");
    footer.className = "pvFooter";
    document.body.appendChild(footer);
  }

  footer.innerHTML = `
    <div class="pvFooterBrand">
      <img id="pvLogo" src="${LOGO}" alt="PontoView">
    </div>
  `;

  // animação
  footer.classList.add("pvEnter");
  setTimeout(() => footer.classList.remove("pvEnter"), 700);

  // opacidade day/night
  const img = footer.querySelector("#pvLogo");
  applyOpacity(img);
  setInterval(() => applyOpacity(img), 60 * 1000);
})();
