import { useId } from 'react';
import { GRADIENT_STOPS, rgbToHex } from '../../../../src/ink/theme.ts';

/** The four arcs and stop colours of docs/images/logo.svg; never a second colour table. */
export function CircleMark({ className = '' }: { className?: string }) {
  const id = useId().replaceAll(':', '');
  const points = [
    [64, 20, 108, 64],
    [108, 64, 64, 108],
    [64, 108, 20, 64],
    [20, 64, 64, 20],
  ];
  return (
    <svg
      className={`circle-logo ${className}`.trim()}
      viewBox="0 0 128 128"
      aria-hidden="true"
    >
      <defs>
        {points.map(([x1, y1, x2, y2], i) => (
          <linearGradient
            key={i}
            id={id + i}
            gradientUnits="userSpaceOnUse"
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
          >
            <stop offset="0" stopColor={rgbToHex(GRADIENT_STOPS[i]![1])} />
            <stop offset="1" stopColor={rgbToHex(GRADIENT_STOPS[i + 1]![1])} />
          </linearGradient>
        ))}
      </defs>
      <g fill="none" strokeWidth="14">
        {points.map(([x1, y1, x2, y2], i) => (
          <path
            key={i}
            d={`M${x1} ${y1} A44 44 0 0 1 ${x2} ${y2}`}
            stroke={`url(#${id + i})`}
          />
        ))}
      </g>
    </svg>
  );
}
