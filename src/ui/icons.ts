/** The Ark mark: a keyhole inside a vault ring — drawn inline so the file
 *  needs no assets, ever. */
export function arkMark(size = 34): SVGElement {
  const ns = "http://www.w3.org/2000/svg"
  const svg = document.createElementNS(ns, "svg")
  svg.setAttribute("width", String(size))
  svg.setAttribute("height", String(size))
  svg.setAttribute("viewBox", "0 0 48 48")
  svg.setAttribute("fill", "none")
  svg.innerHTML = `
    <circle cx="24" cy="24" r="21" stroke="#d9a648" stroke-width="1.6" opacity="0.85"/>
    <circle cx="24" cy="24" r="16.5" stroke="#d9a648" stroke-width="0.8" opacity="0.35"/>
    <circle cx="24" cy="20" r="5.2" stroke="#f0c56d" stroke-width="1.8"/>
    <path d="M24 24.5 L21.4 33 L26.6 33 Z" fill="#f0c56d"/>
    <g stroke="#d9a648" stroke-width="1" opacity="0.5">
      <line x1="24" y1="1.5" x2="24" y2="5"/>
      <line x1="24" y1="43" x2="24" y2="46.5"/>
      <line x1="1.5" y1="24" x2="5" y2="24"/>
      <line x1="43" y1="24" x2="46.5" y2="24"/>
    </g>`
  return svg
}

export function sealGlyph(size = 92): SVGElement {
  const ns = "http://www.w3.org/2000/svg"
  const svg = document.createElementNS(ns, "svg")
  svg.setAttribute("width", String(size))
  svg.setAttribute("height", String(size))
  svg.setAttribute("viewBox", "0 0 48 48")
  svg.setAttribute("class", "ceremony-seal")
  svg.innerHTML = `
    <circle cx="24" cy="24" r="21" fill="rgba(217,166,72,0.08)" stroke="#d9a648" stroke-width="1.4"/>
    <circle cx="24" cy="24" r="15" stroke="#d9a648" stroke-width="0.7" opacity="0.5"/>
    <circle cx="24" cy="20" r="5" stroke="#f0c56d" stroke-width="1.7" fill="none"/>
    <path d="M24 24.5 L21.5 32.6 L26.5 32.6 Z" fill="#f0c56d"/>
    <g stroke="#d9a648" stroke-width="0.9" opacity="0.6">
      <line x1="24" y1="2" x2="24" y2="6.5"/><line x1="24" y1="41.5" x2="24" y2="46"/>
      <line x1="2" y1="24" x2="6.5" y2="24"/><line x1="41.5" y1="24" x2="46" y2="24"/>
      <line x1="8.6" y1="8.6" x2="11.7" y2="11.7"/><line x1="36.3" y1="36.3" x2="39.4" y2="39.4"/>
      <line x1="8.6" y1="39.4" x2="11.7" y2="36.3"/><line x1="36.3" y1="11.7" x2="39.4" y2="8.6"/>
    </g>`
  return svg
}
