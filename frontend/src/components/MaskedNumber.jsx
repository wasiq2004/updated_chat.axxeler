// Renders a phone number in full.
//
// This used to mask the middle digits and reveal them on click. That was only
// ever a UI affordance, never a security control — the full number is sent in
// the clear by /saved-contacts and every other contact endpoint, so anyone with
// DevTools already saw it. All it achieved was an extra click for the operators
// who need the number, on every row.
//
// Kept as a component (rather than deleting it and touching ~11 call sites) so
// the change stays additive and reversible. The name is now a misnomer; it's
// left alone deliberately — renaming it across every consumer is churn with no
// behavioural gain, and this file says why.
//
// Side effect worth knowing: it no longer stopPropagation()s. That was there so
// revealing the number inside a clickable row (contact list, deal card) didn't
// also fire the row's onClick. With nothing to reveal, swallowing the click just
// made part of the row mysteriously dead — now clicking the number opens the row
// like the rest of it.
export default function MaskedNumber({ number, prefix = '', style, title }) {
  if (number === null || number === undefined || number === '') return null;
  return (
    <span title={title} style={style}>
      {prefix}{String(number)}
    </span>
  );
}
