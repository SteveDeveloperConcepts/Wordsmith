interface Props {
  score: number | null;
  size?: number;
}

export function scoreLabel(score: number | null): string {
  if (score === null) return 'Not enough text yet';
  if (score >= 95) return 'Excellent';
  if (score >= 85) return 'Good';
  if (score >= 70) return 'Could use a polish';
  return 'Needs work';
}

/** The overall score as a ring that fills clockwise. */
export function ScoreRing({ score, size = 56 }: Props) {
  const stroke = 5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = score === null ? 0 : Math.max(0, Math.min(1, score / 100));
  const level = score === null ? 'none' : score >= 85 ? 'good' : score >= 70 ? 'warn' : 'bad';
  const center = size / 2;
  return (
    <div
      className={`score score--${level}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={score === null ? 'No score yet' : `Overall score: ${score} out of 100`}
    >
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden>
        <circle className="score__track" cx={center} cy={center} r={radius} strokeWidth={stroke} fill="none" />
        <circle
          className="score__value"
          cx={center}
          cy={center}
          r={radius}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          transform={`rotate(-90 ${center} ${center})`}
        />
      </svg>
      <span className="score__number">{score ?? '–'}</span>
    </div>
  );
}
