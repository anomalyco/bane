import type { CSSProperties } from 'react'
import { gradeKey, type Grade } from '../lib/sender-score'
import './grade-badge.css'

// The sender score badge: the bane square, filled with the grade's colour, the letter set in OpenTUI Mono.
// Before the first grade it is a dashed square that fills from the bottom as the first 100 emails go out.
export function GradeBadge({ grade, size = 'md', label, progress = 0 }: { grade: Grade | null; size?: 'sm' | 'md' | 'lg' | 'xl'; label?: string; progress?: number }) {
  const name = label ?? (grade ? `Sender grade ${grade}` : 'Not graded yet')
  return <span className={`grade-badge grade-badge--${size}`} data-grade={grade ? gradeKey(grade) : 'none'} role="img" aria-label={name} title={name}
    style={grade ? undefined : { '--fill': `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` } as CSSProperties}>
    {grade ? <>{grade[0]}{grade.length > 1 && <span className="grade-badge__plus">+</span>}</> : <><i className="grade-badge__fill" />?</>}
  </span>
}
