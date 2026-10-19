// Decorative artwork for the home hero: black-and-white clouds with a dithered, printed look, drawn with SVG noise filters so there is no
// image to load. It carries no information (aria-hidden) and the text above it is always readable: a dark veil sits between them.
export function HeroArt() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="absolute inset-0 size-full"
      preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <filter id="hero-clouds" x="0" y="0" width="100%" height="100%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.005 0.009"
            numOctaves="5"
            seed="14"
            result="clouds"
          />
          <feColorMatrix in="clouds" type="saturate" values="0" result="grey" />
          <feComponentTransfer in="grey" result="posterised">
            <feFuncR type="discrete" tableValues="0 0 0.08 0.5 0.97 1" />
            <feFuncG type="discrete" tableValues="0 0 0.08 0.5 0.97 1" />
            <feFuncB type="discrete" tableValues="0 0 0.08 0.5 0.97 1" />
          </feComponentTransfer>
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves="1"
            seed="3"
            result="grain"
          />
          <feColorMatrix
            in="grain"
            type="matrix"
            values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1.6 -0.55"
            result="specks"
          />
          <feComposite in="specks" in2="posterised" operator="in" result="speckled" />
          <feBlend in="posterised" in2="speckled" mode="screen" />
        </filter>
      </defs>
      <rect width="100%" height="100%" fill="#000" />
      <rect width="100%" height="100%" filter="url(#hero-clouds)" />
    </svg>
  );
}
