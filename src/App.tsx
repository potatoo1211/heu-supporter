import React, { useState, useEffect, useRef, useMemo } from 'react';
import Editor from '@monaco-editor/react';
import { Code2, Play, LayoutList, Settings, Plus, Folder, ArrowLeft, Loader2, CheckCircle2, AlertCircle, Trophy, Edit2, Clock, Trash2, FileCode2, Eye, ExternalLink, BarChart2, Copy, Check, Star, Sliders, Zap, StopCircle, TrendingUp, RefreshCw, Archive } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { readText } from '@tauri-apps/plugin-clipboard-manager';

type TestCaseResult = { id: number; score: number; status: string; time: number; error_msg: string; };

type Submission = {
  id: string; timestamp: number; time: string; name: string; totalScore: number; codeLength: number;
  status: string; execTime: number; code: string; language: string; testCases: TestCaseResult[];
  submissionNumber?: number;
  compileError?: string | null;
  executionTag?: string | null;
};

type VisData = { html: string; input: string; output: string; stderr: string; web_url: string | null; local_url: string | null };

type ContestConfig = {
  name: string;
  tools_dir: string;
  optimize_target: 'minimize' | 'maximize';
  variables: string;
  score_display?: 'sum' | 'average';
  archived?: boolean;
};

type PendingSubmission = {
  id: string;
  contestName: string;
  code: string;
  language: string;
  caseIds: number[];
  setupTestCases: number;
  timeLimit: number;
  memoryLimit: number;
  executionTag?: string | null;
};

type TuningParam = {
  id: string;
  name: string;
  currentValue: number;
  minValue: number;
  maxValue: number;
  divisions: number;
  paramType: 'int' | 'float';
};

type TuningResult = {
  iteration: number;
  params: Record<string, number>;
  score: number;
  timestamp: number;
};

type TuningSession = {
  id: string;
  name: string;
  savedAt: number;
  code: string;
  params: TuningParam[];
  testCases: number;
  history: TuningResult[];
  best: TuningResult | null;
};

const normalizeTuningParamsForCompare = (params: TuningParam[]) => params.map(p => ({
  name: p.name.trim(),
  currentValue: p.currentValue,
  minValue: p.minValue,
  maxValue: p.maxValue,
  divisions: p.divisions,
  paramType: p.paramType,
}));

const SCORE_FILTER_KEY = '__absolute_score__';

const replaceConstantInCode = (code: string, name: string, value: number, paramType: 'int' | 'float'): string => {
  const valStr = paramType === 'int' ? String(Math.round(value)) : value.toString();
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`((?:const\\s+)?(?:long\\s+long|int|double|float|i32|i64|u32|u64|f64|f32|usize|isize)\\s+${esc}\\s*=\\s*)[\\d.e+\\-]+`, 'g'),
    new RegExp(`(#define\\s+${esc}\\s+)[\\d.e+\\-]+`, 'g'),
    new RegExp(`(const\\s+${esc}\\s*:\\s*[\\w]+\\s*=\\s*)[\\d.e+\\-]+`, 'g'),
    new RegExp(`(let(?:\\s+mut)?\\s+${esc}\\s*(?::[^=\n]*)?=\\s*)[\\d.e+\\-]+`, 'g'),
    new RegExp(`(^[ \\t]*${esc}\\s*=\\s*)[\\d.e+\\-]+`, 'gm'),
  ];
  for (const pat of patterns) {
    const replaced = code.replace(pat, `$1${valStr}`);
    if (replaced !== code) return replaced;
  }
  return code;
};

const buildCodeWithTuningParams = (baseCode: string, params: TuningParam[], values: Record<string, number>) => {
  let nextCode = baseCode;
  params.forEach(param => {
    const value = values[param.name];
    if (value !== undefined) nextCode = replaceConstantInCode(nextCode, param.name, value, param.paramType);
  });
  return nextCode;
};

const getTuningStepSize = (param: TuningParam) => {
  const span = Math.max(param.maxValue - param.minValue, 0);
  const divisions = Math.max(1, Math.floor(param.divisions || 1));
  const raw = span / divisions;
  if (param.paramType === 'float') return Math.max(0.0001, raw || 0.0001);
  return Math.max(1, Math.round(raw || 1));
};

const buildTuningDiscreteValues = (param: TuningParam) => {
  const divisions = Math.max(1, Math.floor(param.divisions || 1));
  const normalize = (value: number) => param.paramType === 'float'
    ? Number(value.toFixed(6))
    : Math.round(value);
  if (param.maxValue === param.minValue) return [normalize(param.minValue)];
  const values = Array.from({ length: divisions + 1 }, (_, i) => {
    const t = i / divisions;
    return normalize(param.minValue + (param.maxValue - param.minValue) * t);
  });
  return Array.from(new Set(values)).sort((a, b) => a - b);
};

// コードから定数を自動検出
const detectConstantsFromCode = (code: string): TuningParam[] => {
  const results: TuningParam[] = [];
  const seen = new Set<string>();
  const addParam = (name: string, rawVal: string) => {
    if (seen.has(name)) return;
    const val = parseFloat(rawVal);
    if (isNaN(val)) return;
    seen.add(name);
    const isFloat = rawVal.includes('.');
    results.push({
      id: `${name}_${Date.now()}_${Math.random()}`,
      name,
      currentValue: val,
      minValue: isFloat ? Math.max(0, val * 0.2) : Math.max(1, Math.floor(val * 0.2)),
      maxValue: isFloat ? val * 5 : Math.ceil(val * 5),
      divisions: 5,
      paramType: isFloat ? 'float' : 'int',
    });
  };
  const patterns: [RegExp, number, number][] = [
    [/(?:const\s+)?(?:long\s+long|int|double|float)\s+([A-Z_][A-Z0-9_]{1,})\s*=\s*([\d.e+\-]+)/g, 1, 2],
    [/#define\s+([A-Z_][A-Z0-9_]{1,})\s+([\d.e+\-]+)/g, 1, 2],
    [/const\s+([A-Z_][A-Z0-9_]{1,})\s*:\s*\w+\s*=\s*([\d.e+\-]+)/g, 1, 2],
  ];
  for (const [pat, ni, vi] of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pat.exec(code)) !== null) addParam(m[ni], m[vi]);
  }
  return results;
};

// ピアソンの相関係数を計算
const calcCorrelation = (x: number[], y: number[]) => {
  const n = x.length;
  if (n === 0) return 0;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((acc, val, i) => acc + val * y[i], 0);
  const sumX2 = x.reduce((a, b) => a + b * b, 0);
  const sumY2 = y.reduce((a, b) => a + b * b, 0);
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return den === 0 ? 0 : num / den;
};

// 箱ひげ図用の統計量を計算（現在未使用）
// const calcBoxStats = (arr: number[]) => {
//   if (arr.length === 0) return { min: 0, q1: 0, median: 0, q3: 0, max: 0, mean: 0, variance: 0 };
//   const sorted = [...arr].sort((a, b) => a - b);
//   const n = sorted.length;
//   const mean = arr.reduce((a, b) => a + b, 0) / n;
//   const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
//   return { min: sorted[0], q1: sorted[Math.floor(n * 0.25)], median: sorted[Math.floor(n / 2)], q3: sorted[Math.floor(n * 0.75)], max: sorted[n - 1], mean, variance };
// };

const calcBoxStatsWithIds = (entries: { score: number; id: number }[]) => {
  if (entries.length === 0) return { min: 0, q1: 0, median: 0, q3: 0, max: 0, mean: 0, variance: 0, minId: 0, q1Id: 0, medianId: 0, q3Id: 0, maxId: 0 };
  const sorted = [...entries].sort((a, b) => a.score - b.score);
  const n = sorted.length;
  const mean = entries.reduce((a, b) => a + b.score, 0) / n;
  const variance = entries.reduce((a, b) => a + (b.score - mean) ** 2, 0) / n;
  return {
    min: sorted[0].score, minId: sorted[0].id,
    q1: sorted[Math.floor(n * 0.25)].score, q1Id: sorted[Math.floor(n * 0.25)].id,
    median: sorted[Math.floor(n / 2)].score, medianId: sorted[Math.floor(n / 2)].id,
    q3: sorted[Math.floor(n * 0.75)].score, q3Id: sorted[Math.floor(n * 0.75)].id,
    max: sorted[n - 1].score, maxId: sorted[n - 1].id,
    mean, variance,
  };
};

// ホバーツールチップ（散布図・箱ひげ図共用）
const ChartPointTooltip = ({ score, id, label }: { score: number; id: number; label: string }) => (
  <div className="bg-gray-900 text-white text-xs rounded-lg px-3 py-2 shadow-lg pointer-events-none">
    {label && <p className="font-bold text-yellow-300 mb-0.5">{label}</p>}
    <p>スコア: {score.toLocaleString()}</p>
    <p className="text-gray-300">seed: {String(id).padStart(4, '0')}</p>
    <p className="text-gray-400 mt-1">クリックでビジュアライズ</p>
  </div>
);

const CHART_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6'];

// コピーボタン（フィードバックつき）
const CopyButton = ({ text, className = '' }: { text: string; className?: string }) => {
  const [copied, setCopied] = React.useState(false);
  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };
  return (
    <button onClick={handleCopy} className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold transition-colors ${copied ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-700'} ${className}`} title="コピー">
      {copied ? <Check size={12} /> : <Copy size={12} />}{copied ? '完了' : 'コピー'}
    </button>
  );
};

// インアプリ確認ダイアログ
const ConfirmDialog = ({ message, subMessage, onConfirm, onCancel, confirmLabel = '削除', confirmColor = 'bg-red-600 hover:bg-red-700' }: {
  message: string; subMessage?: string;
  onConfirm: () => void; onCancel: () => void;
  confirmLabel?: string; confirmColor?: string;
}) => (
  <div className="fixed inset-0 bg-black/40 z-[100] flex items-center justify-center p-4 backdrop-blur-sm">
    <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden">
      <div className="p-5">
        <p className="font-bold text-gray-800 text-base">{message}</p>
        {subMessage && <p className="text-sm text-gray-500 mt-1">{subMessage}</p>}
      </div>
      <div className="px-5 pb-4 flex justify-end gap-3">
        <button onClick={onCancel} className="px-4 py-2 text-sm font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors">キャンセル</button>
        <button onClick={onConfirm} className={`px-4 py-2 text-sm font-bold text-white rounded-lg transition-colors ${confirmColor}`}>{confirmLabel}</button>
      </div>
    </div>
  </div>
);
// ─────────────────────────────────────────
interface HoverInfo { score: number; id: number; label: string; px: number; py: number; subId?: string }
interface ScatterPoint { x: number; y: number; id: number }
interface ScatterSeries { subId: string; subName: string; data: ScatterPoint[] }

type RelScoreTooltip = {
  caseId: number;
  x: number;
  y: number;
  bestScore: number;
  winners: { id: string; name: string; score: number }[];
};

// ページネーションコンポーネント
const Pagination = ({ page, total, pageSize, onPage, onPageSize }: {
  page: number; total: number; pageSize: number;
  onPage: (p: number) => void; onPageSize: (s: number) => void;
}) => {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex items-center justify-between py-2 px-1 text-sm text-gray-600 select-none">
      <span className="text-xs text-gray-400">{from}–{to} / {total} 件</span>
      <div className="flex items-center gap-2">
        <select value={pageSize} onChange={e => { onPageSize(Number(e.target.value)); onPage(1); }}
          className="border rounded px-1.5 py-1 text-xs bg-white">
          {[20, 50, 100].map(s => <option key={s} value={s}>{s}件</option>)}
        </select>
        <button onClick={() => onPage(1)} disabled={page === 1}
          className="px-1.5 py-1 rounded disabled:opacity-30 hover:bg-gray-100 transition-colors font-bold">«</button>
        <button onClick={() => onPage(page - 1)} disabled={page === 1}
          className="px-2 py-1 rounded disabled:opacity-30 hover:bg-gray-100 transition-colors font-bold">‹</button>
        <span className="text-xs font-bold">{page} / {totalPages}</span>
        <button onClick={() => onPage(page + 1)} disabled={page === totalPages}
          className="px-2 py-1 rounded disabled:opacity-30 hover:bg-gray-100 transition-colors font-bold">›</button>
        <button onClick={() => onPage(totalPages)} disabled={page === totalPages}
          className="px-1.5 py-1 rounded disabled:opacity-30 hover:bg-gray-100 transition-colors font-bold">»</button>
      </div>
    </div>
  );
};

const TuningRangeSlider = ({ param, onChange }: {
  param: TuningParam;
  onChange: (next: Partial<TuningParam>) => void;
}) => {
  const coreMin = Math.min(param.minValue, param.maxValue, param.currentValue);
  const coreMax = Math.max(param.minValue, param.maxValue, param.currentValue);
  const coreRange = Math.max(coreMax - coreMin, 1);
  const padding = Math.max(coreRange * 0.75, Math.abs(coreMin) * 0.25, Math.abs(coreMax) * 0.25, 1);
  const sliderMin = coreMin - padding;
  const sliderMax = coreMax + padding;
  const range = sliderMax - sliderMin || 1;
  const left = ((param.minValue - sliderMin) / range) * 100;
  const right = ((param.maxValue - sliderMin) / range) * 100;
  const current = ((param.currentValue - sliderMin) / range) * 100;
  const divisionCount = Math.max(1, Math.floor(param.divisions || 1));
  const handleOffsetPx = 8;
  const display = (value: number) => param.paramType === 'float'
    ? value.toFixed(3).replace(/\.?0+$/, '')
    : Math.round(value).toLocaleString();
  const sliderRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<{ side: 'min' | 'max'; startValue: number } | null>(null);

  const normalizeValue = (value: number) => {
    if (param.paramType === 'float') return Number(value.toFixed(3));
    return Math.round(value);
  };

  const dragLimit = (startValue: number) => Math.max(Math.abs(startValue), 1);

  const startDrag = (side: 'min' | 'max') => (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      side,
      startValue: side === 'min' ? param.minValue : param.maxValue,
    };

    const handleMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      const slider = sliderRef.current;
      if (!drag || !slider) return;
      const rect = slider.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(rect.width, 1)));
      const rawValue = sliderMin + ratio * range;
      const limited = Math.max(
        drag.startValue - dragLimit(drag.startValue),
        Math.min(drag.startValue + dragLimit(drag.startValue), rawValue),
      );
      const value = normalizeValue(limited);

      if (drag.side === 'min') {
        const capped = Math.min(value, param.currentValue);
        onChange({
          minValue: Math.min(capped, param.maxValue),
        });
      } else {
        const capped = Math.max(value, param.currentValue);
        onChange({
          maxValue: Math.max(capped, param.minValue),
        });
      }
    };

    const handleUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  return (
    <div className="space-y-2">
      <div ref={sliderRef} className="relative pt-6 pb-5">
        <div className="absolute left-0 right-0 top-[26px] h-2 rounded-full bg-gray-200" />
        <div
          className="absolute top-[26px] h-2 rounded-full bg-purple-400"
          style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }}
        />
        {Array.from({ length: divisionCount + 1 }, (_, i) => {
          const pos = left + ((right - left) * i) / divisionCount;
          return (
            <div key={i} className="absolute top-[20px] -translate-x-1/2" style={{ left: `${pos}%` }}>
              <div className="w-1 h-1 rounded-full bg-purple-700/70" />
            </div>
          );
        })}
        <div className="absolute top-[18px] -translate-x-1/2" style={{ left: `${current}%` }}>
          <div className="w-3 h-3 rounded-full bg-emerald-500 border-2 border-white shadow" />
        </div>
        <div
          className="absolute top-[19px] -translate-x-1/2 cursor-ew-resize"
          style={{ left: `calc(${left}% - ${handleOffsetPx}px)` }}
          onMouseDown={startDrag('min')}
        >
          <div className="w-4 h-4 rounded-full bg-purple-600 border-2 border-white shadow-md" />
        </div>
        <div
          className="absolute top-[19px] -translate-x-1/2 cursor-ew-resize"
          style={{ left: `calc(${right}% + ${handleOffsetPx}px)` }}
          onMouseDown={startDrag('max')}
        >
          <div className="w-4 h-4 rounded-full bg-purple-600 border-2 border-white shadow-md" />
        </div>
      </div>
      <div className="flex items-center justify-between text-[11px] text-gray-500 font-mono">
        <span>min {display(param.minValue)}</span>
        <span className="text-emerald-600 font-bold">current {display(param.currentValue)}</span>
        <span>{divisionCount} 分割</span>
        <span>max {display(param.maxValue)}</span>
      </div>
    </div>
  );
};

const SvgScatterPlot = React.memo(({
  plotData, yDomain, xLabel, subColorMap, onHover, onLeave, onClickPoint, hoveredId, activeVisId,
}: {
  plotData: ScatterSeries[];
  yDomain: [number, number];
  xLabel: string;
  subColorMap: Record<string, number>;
  onHover: (info: HoverInfo) => void;
  onLeave: () => void;
  onClickPoint: (id: number) => void;
  hoveredId: number | null;
  activeVisId: number | null;
}) => {
  const ML = 68, MR = 16, MT = 12, MB = 38;
  const SVG_W = 560, SVG_H = 300;
  const iW = SVG_W - ML - MR;
  const iH = SVG_H - MT - MB;

  const allX = plotData.flatMap(pd => pd.data.map(d => d.x));
  if (allX.length === 0) return <div className="h-72 flex items-center justify-center text-gray-400 text-sm">データなし</div>;

  const xMin = Math.min(...allX), xMax = Math.max(...allX);
  const [yMin, yMax] = yDomain;
  const xRange = xMax === xMin ? 1 : xMax - xMin;
  const yRange = yMax === yMin ? 1 : yMax - yMin;

  const toSX = (x: number) => ML + ((x - xMin) / xRange) * iW;
  const toSY = (y: number) => MT + (1 - (y - yMin) / yRange) * iH;

  const yTicks = Array.from({ length: 7 }, (_, i) => yMin + (yRange * i) / 6);
  const xVals = [...new Set(allX)].sort((a, b) => a - b);
  const xTicks = xVals.length <= 12 ? xVals : Array.from({ length: 9 }, (_, i) => Math.round(xMin + (xRange * i) / 8));

  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} style={{ display: 'block', width: '100%', height: SVG_H }}>
      {/* グリッド */}
      {yTicks.map((y, i) => (
        <line key={i} x1={ML} y1={toSY(y)} x2={SVG_W - MR} y2={toSY(y)} stroke="#e5e7eb" strokeWidth={1} strokeDasharray="3 3" />
      ))}
      {/* 軸 */}
      <line x1={ML} y1={MT} x2={ML} y2={SVG_H - MB} stroke="#9ca3af" strokeWidth={1} />
      <line x1={ML} y1={SVG_H - MB} x2={SVG_W - MR} y2={SVG_H - MB} stroke="#9ca3af" strokeWidth={1} />
      {/* Y 軸ラベル */}
      {yTicks.map((y, i) => (
        <text key={i} x={ML - 5} y={toSY(y) + 4} textAnchor="end" fontSize={9} fill="#6b7280">
          {Math.round(y).toLocaleString()}
        </text>
      ))}
      {/* X 軸ラベル */}
      {xTicks.map((x, i) => (
        <text key={i} x={toSX(x)} y={SVG_H - MB + 14} textAnchor="middle" fontSize={10} fill="#6b7280">{x}</text>
      ))}
      <text x={SVG_W / 2} y={SVG_H - 3} textAnchor="middle" fontSize={11} fill="#374151">{xLabel}</text>
      {/* 散布点（ヒットエリア先行 → 見た目の点） */}
      {plotData.map((pd) => {
        const ci = subColorMap[pd.subId] ?? 0;
        const color = CHART_COLORS[ci % CHART_COLORS.length];
        return pd.data.map(d => {
          const sx = toSX(d.x), sy = toSY(d.y);
          const isHovered = d.id === hoveredId;
          const isActive = d.id === activeVisId;
          return (
            <g key={d.id}
              style={{ cursor: 'pointer' }}
              onMouseEnter={(e) => onHover({ score: d.y, id: d.id, label: '', subId: pd.subId, px: e.clientX, py: e.clientY })}
              onMouseLeave={onLeave}
              onClick={() => onClickPoint(d.id)}
            >
              {/* 大きめ透明ヒットエリア */}
              <circle cx={sx} cy={sy} r={12} fill="transparent" />
              {/* 通常の点 */}
              <circle cx={sx} cy={sy} r={isHovered || isActive ? 6 : 4}
                fill={isActive ? '#f97316' : color}
                fillOpacity={isHovered ? 1 : isActive ? 0.95 : 0.72}
                stroke={isActive ? '#f97316' : color}
                strokeWidth={isHovered || isActive ? 1.5 : 1}
                style={{ pointerEvents: 'none' }} />
              {/* hover リング */}
              {isHovered && !isActive && (
                <g style={{ pointerEvents: 'none' }}>
                  <circle cx={sx} cy={sy} r={11} fill="none" stroke="white" strokeWidth={3} />
                  <circle cx={sx} cy={sy} r={11} fill="none" stroke={color} strokeWidth={2} />
                </g>
              )}
              {/* activeVis リング（オレンジ破線） */}
              {isActive && (
                <g style={{ pointerEvents: 'none' }}>
                  <circle cx={sx} cy={sy} r={12} fill="none" stroke="white" strokeWidth={4} />
                  <circle cx={sx} cy={sy} r={12} fill="#f97316" fillOpacity={0.15} stroke="#f97316" strokeWidth={2.5} strokeDasharray="4 2" />
                </g>
              )}
            </g>
          );
        });
      })}
      {/* activeVis ラベル */}
      {activeVisId !== null && (() => {
        for (const pd of plotData) {
          const pt = pd.data.find(d => d.id === activeVisId);
          if (pt) {
            const sx = toSX(pt.x), sy = toSY(pt.y);
            const labelX = sx + 16, labelY = sy - 6;
            return (
              <g style={{ pointerEvents: 'none' }}>
                <rect x={labelX - 2} y={labelY - 11} width={62} height={14} rx={3} fill="#f97316" fillOpacity={0.9} />
                <text x={labelX + 29} y={labelY} textAnchor="middle" fontSize={10} fill="white" fontWeight="bold">▶ 表示中</text>
              </g>
            );
          }
        }
        return null;
      })()}
    </svg>
  );
});

// ─────────────────────────────────────────
// 純粋 SVG 箱ひげ図コンポーネント
// ─────────────────────────────────────────
const SvgBoxPlot = React.memo(({
  chartData, uniqueVals, compareSubmissions, subColorMap, yDomain, varName, onHover, onLeave, onClickPoint,
  hoveredScore, activeVisScore,
}: {
  chartData: Record<string, any>[];
  uniqueVals: number[];
  compareSubmissions: any[];
  subColorMap: Record<string, number>;
  yDomain: [number, number];
  varName: string;
  onHover: (info: HoverInfo) => void;
  onLeave: () => void;
  onClickPoint: (id: number) => void;
  hoveredScore?: number | null;
  activeVisScore?: number | null;
}) => {
  const ML = 68, MR = 20, MT = 14, MB = 38;
  const SVG_H = 320;
  const iH = SVG_H - MT - MB;

  const nSubs = compareSubmissions.length;
  const BOX_HW = 11;    // box half-width
  const SUB_GAP = 8;    // gap between subs in same group
  const GROUP_PAD = 20; // padding at each side of a group
  const groupW = nSubs * BOX_HW * 2 + (nSubs - 1) * SUB_GAP + GROUP_PAD * 2;
  const iW = uniqueVals.length * groupW;
  const SVG_W = ML + iW + MR;

  const [yMin, yMax] = yDomain;
  const yRange = yMax === yMin ? 1 : yMax - yMin;
  const toSY = (y: number) => MT + (1 - (y - yMin) / yRange) * iH;

  const getGroupCX = (gi: number, si: number) =>
    ML + gi * groupW + GROUP_PAD + si * (BOX_HW * 2 + SUB_GAP) + BOX_HW;

  const yTicks = Array.from({ length: 7 }, (_, i) => yMin + (yRange * i) / 6);
  const HIT_H = 28;

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={SVG_W} height={SVG_H} style={{ display: 'block' }}>
        {/* グリッド */}
        {yTicks.map((y, i) => (
          <line key={i} x1={ML} y1={toSY(y)} x2={SVG_W - MR} y2={toSY(y)} stroke="#e5e7eb" strokeWidth={1} strokeDasharray="3 3" />
        ))}
        {/* 軸 */}
        <line x1={ML} y1={MT} x2={ML} y2={SVG_H - MB} stroke="#9ca3af" strokeWidth={1} />
        <line x1={ML} y1={SVG_H - MB} x2={SVG_W - MR} y2={SVG_H - MB} stroke="#9ca3af" strokeWidth={1} />
        {/* Y 軸ラベル */}
        {yTicks.map((y, i) => (
          <text key={i} x={ML - 5} y={toSY(y) + 4} textAnchor="end" fontSize={9} fill="#6b7280">
            {Math.round(y).toLocaleString()}
          </text>
        ))}
        {/* X 軸ラベル（グループ中心） */}
        {uniqueVals.map((xVal, gi) => (
          <text key={gi} x={ML + gi * groupW + groupW / 2} y={SVG_H - MB + 16} textAnchor="middle" fontSize={11} fill="#374151">{xVal}</text>
        ))}
        <text x={(ML + SVG_W - MR) / 2} y={SVG_H - 3} textAnchor="middle" fontSize={11} fill="#374151">{varName}</text>
        {/* 各グループの箱ひげ図 */}
        {uniqueVals.map((_, gi) => {
          const row = chartData[gi];
          return compareSubmissions.map((sub, si) => {
            const ci = subColorMap[sub.id] ?? si;
            const color = CHART_COLORS[ci % CHART_COLORS.length];
            const pmin = row[`s${ci}_min`]; const minId = row[`s${ci}_minId`];
            const pq1 = row[`s${ci}_q1`]; const q1Id = row[`s${ci}_q1Id`];
            const pmed = row[`s${ci}_median`]; const medId = row[`s${ci}_medianId`];
            const pq3 = row[`s${ci}_q3`]; const q3Id = row[`s${ci}_q3Id`];
            const pmax = row[`s${ci}_max`]; const maxId = row[`s${ci}_maxId`];
            const pmean = row[`s${ci}_mean`];
            if (pmin === undefined) return null;

            const cx = getGroupCX(gi, si);
            const yMinPx = toSY(pmin), yMaxPx = toSY(pmax);
            const yQ1Px = toSY(pq1), yQ3Px = toSY(pq3);
            const yMedPx = toSY(pmed);
            const yMeanPx = pmean !== undefined ? toSY(pmean) : null;
            const boxTop = Math.min(yQ1Px, yQ3Px);
            const boxH = Math.max(Math.abs(yQ1Px - yQ3Px), 1);
            const hw = BOX_HW, arm = 5;
            const hitW = hw * 2 + 8;

            return (
              <g key={`${gi}-${si}`} stroke={color} strokeWidth={1.5} fill="none">
                {/* ひげ（縦線・端の横線） */}
                <line x1={cx} y1={yMinPx} x2={cx} y2={yMaxPx} strokeDasharray="3 3" opacity={0.5} style={{ pointerEvents: 'none' }} />
                <line x1={cx - hw} y1={yMinPx} x2={cx + hw} y2={yMinPx} style={{ pointerEvents: 'none' }} />
                <line x1={cx - hw} y1={yMaxPx} x2={cx + hw} y2={yMaxPx} style={{ pointerEvents: 'none' }} />
                {/* IQR ボックス */}
                <rect x={cx - hw} y={boxTop} width={hw * 2} height={boxH} fill={color} fillOpacity={0.25} stroke={color} style={{ pointerEvents: 'none' }} />
                {/* 中央値 */}
                <line x1={cx - hw} y1={yMedPx} x2={cx + hw} y2={yMedPx} strokeWidth={2.5} style={{ pointerEvents: 'none' }} />
                {/* 平均（十字） */}
                {yMeanPx !== null && (
                  <g strokeWidth={2} style={{ pointerEvents: 'none' }}>
                    <line x1={cx - arm} y1={yMeanPx} x2={cx + arm} y2={yMeanPx} />
                    <line x1={cx} y1={yMeanPx - arm} x2={cx} y2={yMeanPx + arm} />
                  </g>
                )}
                {/* ヒットエリア（最前面に配置・直接イベント） */}
                {([
                  [pmax, maxId, '最大値', yMaxPx],
                  [pq3, q3Id, 'Q3 (75%)', yQ3Px],
                  [pmed, medId, '中央値', yMedPx],
                  [pq1, q1Id, 'Q1 (25%)', yQ1Px],
                  [pmin, minId, '最小値', yMinPx],
                ] as [number, number, string, number][]).map(([score, id, label, py]) => (
                  <rect
                    key={label}
                    x={cx - hw - 4} y={py - HIT_H / 2} width={hitW} height={HIT_H}
                    fill="transparent" stroke="none"
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={(e) => onHover({ score, id, label, subId: sub.id, px: e.clientX, py: e.clientY })}
                    onMouseLeave={onLeave}
                    onClick={() => onClickPoint(id)}
                  />
                ))}
              </g>
            );
          });
        })}
        {/* hover クロスライン */}
        {hoveredScore !== null && hoveredScore !== undefined && (() => {
          const hy = toSY(hoveredScore);
          if (hy < MT || hy > SVG_H - MB) return null;
          return (
            <g style={{ pointerEvents: 'none' }}>
              <line x1={ML} y1={hy} x2={SVG_W - MR} y2={hy} stroke="#94a3b8" strokeWidth={1} strokeDasharray="4 3" />
              <circle cx={ML - 4} cy={hy} r={3} fill="#94a3b8" />
            </g>
          );
        })()}
        {/* activeVis ライン（オレンジ） */}
        {activeVisScore !== null && activeVisScore !== undefined && (() => {
          const ay = toSY(activeVisScore);
          if (ay < MT || ay > SVG_H - MB) return null;
          const labelW = 80;
          return (
            <g style={{ pointerEvents: 'none' }}>
              <line x1={ML} y1={ay} x2={SVG_W - MR} y2={ay} stroke="#f97316" strokeWidth={1.5} strokeDasharray="5 3" />
              <polygon points={`${ML},${ay} ${ML - 7},${ay - 5} ${ML - 7},${ay + 5}`} fill="#f97316" />
              <rect x={ML + 5} y={ay - 13} width={labelW} height={13} rx={3} fill="#f97316" fillOpacity={0.9} />
              <text x={ML + 5 + labelW / 2} y={ay - 3} textAnchor="middle" fontSize={10} fill="white" fontWeight="bold">
                ▶ {activeVisScore && activeVisScore.toLocaleString()}
              </text>
            </g>
          );
        })()}
      </svg>
    </div>
  );
});

// ─────────────────────────────────────────
// seed 折れ線グラフ（X軸=seed、提出ごとに線で結ぶ）
// ─────────────────────────────────────────
interface SeedLineSeries { subId: string; subName: string; data: { id: number; score: number }[] }
const SvgSeedLinePlot = React.memo(({
  series, yDomain, subColorMap, onHover, onLeave, onClickPoint, hoveredId, activeVisId, activeVisSubId,
}: {
  series: SeedLineSeries[];
  yDomain: [number, number];
  subColorMap: Record<string, number>;
  onHover: (info: HoverInfo) => void;
  onLeave: () => void;
  onClickPoint: (id: number, subId: string) => void;
  hoveredId: number | null;
  activeVisId: number | null;
  activeVisSubId: string | null;
}) => {
  const ML = 68, MR = 16, MT = 12, MB = 38;
  const SVG_W = 560, SVG_H = 300;
  const iW = SVG_W - ML - MR, iH = SVG_H - MT - MB;

  const allIds = [...new Set(series.flatMap(s => s.data.map(d => d.id)))].sort((a, b) => a - b);
  if (allIds.length === 0) return <div className="h-72 flex items-center justify-center text-gray-400 text-sm">データなし</div>;

  const xMin = allIds[0], xMax = allIds[allIds.length - 1];
  const [yMin, yMax] = yDomain;
  const xRange = xMax === xMin ? 1 : xMax - xMin;
  const yRange = yMax === yMin ? 1 : yMax - yMin;
  const toSX = (x: number) => ML + ((x - xMin) / xRange) * iW;
  const toSY = (y: number) => MT + (1 - (y - yMin) / yRange) * iH;

  const yTicks = Array.from({ length: 7 }, (_, i) => yMin + (yRange * i) / 6);
  const xTicks = allIds.length <= 20 ? allIds : Array.from({ length: 9 }, (_, i) => Math.round(xMin + (xRange * i) / 8));

  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} style={{ display: 'block', width: '100%', height: SVG_H }}>
      {yTicks.map((y, i) => <line key={i} x1={ML} y1={toSY(y)} x2={SVG_W - MR} y2={toSY(y)} stroke="#e5e7eb" strokeWidth={1} strokeDasharray="3 3" />)}
      <line x1={ML} y1={MT} x2={ML} y2={SVG_H - MB} stroke="#9ca3af" strokeWidth={1} />
      <line x1={ML} y1={SVG_H - MB} x2={SVG_W - MR} y2={SVG_H - MB} stroke="#9ca3af" strokeWidth={1} />
      {yTicks.map((y, i) => <text key={i} x={ML - 5} y={toSY(y) + 4} textAnchor="end" fontSize={9} fill="#6b7280">{Math.round(y).toLocaleString()}</text>)}
      {xTicks.map((x, i) => <text key={i} x={toSX(x)} y={SVG_H - MB + 14} textAnchor="middle" fontSize={10} fill="#6b7280">{x}</text>)}
      <text x={SVG_W / 2} y={SVG_H - 3} textAnchor="middle" fontSize={11} fill="#374151">seed</text>
      {/* 折れ線 */}
      {series.map((s) => {
        const ci = subColorMap[s.subId] ?? 0;
        const color = CHART_COLORS[ci % CHART_COLORS.length];
        const sorted = [...s.data].sort((a, b) => a.id - b.id);
        const pts = sorted.map(d => `${toSX(d.id)},${toSY(d.score)}`).join(' ');
        return (
          <polyline key={s.subId} points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeOpacity={0.55} style={{ pointerEvents: 'none' }} />
        );
      })}
      {/* 点（ヒットエリア付き） */}
      {series.map((s) => {
        const ci = subColorMap[s.subId] ?? 0;
        const color = CHART_COLORS[ci % CHART_COLORS.length];
        return s.data.map(d => {
          const sx = toSX(d.id), sy = toSY(d.score);
          const isHovered = d.id === hoveredId;
          const isActive = d.id === activeVisId && s.subId === activeVisSubId;
          return (
            <g key={`${s.subId}-${d.id}`} style={{ cursor: 'pointer' }}
              onMouseEnter={(e) => onHover({ score: d.score, id: d.id, label: s.subName, subId: s.subId, px: e.clientX, py: e.clientY })}
              onMouseLeave={onLeave}
              onClick={() => onClickPoint(d.id, s.subId)}
            >
              <circle cx={sx} cy={sy} r={10} fill="transparent" />
              <circle cx={sx} cy={sy} r={isHovered || isActive ? 5 : 3}
                fill={isActive ? '#f97316' : color}
                fillOpacity={isHovered ? 1 : isActive ? 0.95 : 0.8}
                stroke={isActive ? '#f97316' : color} strokeWidth={1}
                style={{ pointerEvents: 'none' }} />
              {isActive && <circle cx={sx} cy={sy} r={10} fill="none" stroke="#f97316" strokeWidth={2} strokeDasharray="4 2" style={{ pointerEvents: 'none' }} />}
            </g>
          );
        });
      })}
      {/* activeVis ラベル */}
      {activeVisId !== null && (() => {
        const activeSeries = series.find(s => s.subId === activeVisSubId);
        if (!activeSeries) return null;
        const pt = activeSeries.data.find(d => d.id === activeVisId);
        if (!pt) return null;
        const sx = toSX(pt.id), sy = toSY(pt.score);
        return (
          <g style={{ pointerEvents: 'none' }}>
            <rect x={sx + 8} y={sy - 13} width={62} height={14} rx={3} fill="#f97316" fillOpacity={0.9} />
            <text x={sx + 39} y={sy - 2} textAnchor="middle" fontSize={10} fill="white" fontWeight="bold">▶ 表示中</text>
          </g>
        );
      })()}
    </svg>
  );
});

// --- ↑ ここまで ↑ ---


// ① ContestItem型を定義
type ContestItem = { name: string; updated_at: number; archived?: boolean };

// 散布図はカスタムホバーツールチップを使うため、Recharts標準ツールチップは不要（現在未使用）
// const CustomTooltip = () => null;

// タイムスタンプを「YYYY/MM/DD HH:mm」形式に変換する関数
const formatTimestamp = (timestamp: number) => {
  // Rustから秒単位で来るので、1000を掛けてミリ秒にする
  const date = new Date(timestamp * 1000);
  return date.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const parseSubmissionNumberFromName = (name: string) => {
  const match = name.match(/^提出\s+(\d+)$/);
  return match ? Number(match[1]) : null;
};

const normalizeSubmissionNumbers = (list: Submission[]) => {
  const sorted = [...list].sort((a, b) => a.timestamp - b.timestamp);
  let nextNumber = 1;
  const numberById = new Map<string, number>();

  for (const sub of sorted) {
    const existingNumber = sub.submissionNumber ?? parseSubmissionNumberFromName(sub.name);
    const assignedNumber = existingNumber && existingNumber >= 1 ? existingNumber : nextNumber;
    numberById.set(sub.id, assignedNumber);
    nextNumber = Math.max(nextNumber, assignedNumber + 1);
  }

  return list.map(sub => ({ ...sub, submissionNumber: numberById.get(sub.id) ?? 1 }));
};

const deferredSectionStyle: React.CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: '560px',
};

function App() {
  const visIframeRef = useRef<HTMLIFrameElement>(null);
  const editorRef = useRef<any>(null);
  const clipboardCacheRef = useRef<string>(''); // Ctrl+A後のクリップボード汚染対策用キャッシュ
  const [logicalProcessorCount, setLogicalProcessorCount] = useState(4);
  const [contests, setContests] = useState<ContestItem[]>([]);
  const [sortType, setSortType] = useState<'date' | 'name'>('date');
  const [currentContest, setCurrentContest] = useState<string | null>(null);
  const [newContestName, setNewContestName] = useState('');
  const [newOptimizeTarget, setNewOptimizeTarget] = useState<'minimize' | 'maximize'>('maximize');
  const [newVariables, setNewVariables] = useState<string>('');
  const [activeTab, setActiveTab] = useState('submit');
  const [language, setLanguage] = useState('cpp');
  const [testCases, setTestCases] = useState(50);
  const [timeLimit, setTimeLimit] = useState(2.0);
  const [memoryLimit, setMemoryLimit] = useState(1024);
  const DEFAULT_CODE: Record<string, string> = {
    cpp: `#include <iostream>\nusing namespace std;\n\nint main() {\n    // ここにコードを記述\n    return 0;\n}`,
    rust: `use std::io::{self, Read};\n\nfn main() {\n    let mut input = String::new();\n    io::stdin().read_to_string(&mut input).unwrap();\n    let mut iter = input.split_whitespace();\n    // ここにコードを記述\n}`,
    python: `import sys\ninput = sys.stdin.readline\n\ndef main():\n    # ここにコードを記述\n    pass\n\nmain()`,
  };
  const [code, setCode] = useState(DEFAULT_CODE['cpp']);

  const [confirmDialog, setConfirmDialog] = useState<{ message: string; subMessage?: string; onConfirm: () => void; confirmLabel?: string } | null>(null);

  // ── 定数チューニング state ──
  const [tuningParams, setTuningParams] = useState<TuningParam[]>([]);
  const [tuningCode, setTuningCode] = useState('');
  const [tuningTestCases, setTuningTestCases] = useState(20);
  const [tuningStatus, setTuningStatus] = useState<'idle' | 'running' | 'paused'>('idle');
  const [tuningIterCount, setTuningIterCount] = useState(0);
  const [tuningBest, setTuningBest] = useState<TuningResult | null>(null);
  const [tuningHistory, setTuningHistory] = useState<TuningResult[]>([]);
  const [tuningSessions, setTuningSessions] = useState<TuningSession[]>([]);
  const [selectedTuningSessionId, setSelectedTuningSessionId] = useState<string | null>(null);
  const [tuningAvgIterSec, setTuningAvgIterSec] = useState<number | null>(null);
  const [tuningElapsedSec, setTuningElapsedSec] = useState(0);
  const isTuningRef = useRef(false);
  const shouldPauseTuningRef = useRef(false);
  const tuningPausedRef = useRef(false);
  const tuningBestRef = useRef<TuningResult | null>(null);
  const tuningHistoryRef = useRef<TuningResult[]>([]);
  const tuningStartTimeRef = useRef(0);
  const tuningElapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tuningSessionIdRef = useRef<string | null>(null);

  const showConfirm = (message: string, subMessage: string | undefined, onConfirm: () => void, confirmLabel?: string) => {
    setConfirmDialog({ message, subMessage, onConfirm, confirmLabel });
  };

  // ファイルダイアログの初期フォルダ（WSL環境でCドライブを開くための設定）
  const [dialogDefaultPath, setDialogDefaultPath] = useState<string>(() => {
    return localStorage.getItem('heu_dialog_default_path') || '/mnt/c/';
  });
  const [parallelism, setParallelism] = useState<number>(() => {
    const saved = localStorage.getItem('heu_parallelism');
    const parsed = saved ? Number(saved) : NaN;
    return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 3;
  });
  const editorStateKey = currentContest ? `heu_editor_${currentContest}` : null;
  useEffect(() => {
    localStorage.setItem('heu_dialog_default_path', dialogDefaultPath);
  }, [dialogDefaultPath]);
  useEffect(() => {
    localStorage.setItem('heu_parallelism', String(Math.max(1, Math.floor(parallelism))));
  }, [parallelism]);
  useEffect(() => {
    invoke<number>('get_available_parallelism')
      .then((count) => {
        const normalized = Math.max(1, Math.floor(count || 1));
        setLogicalProcessorCount(normalized);
        const saved = localStorage.getItem('heu_parallelism');
        if (!saved) setParallelism(Math.max(1, normalized - 1));
      })
      .catch(() => {
        const fallback = Math.max(1, navigator.hardwareConcurrency || 4);
        setLogicalProcessorCount(fallback);
        const saved = localStorage.getItem('heu_parallelism');
        if (!saved) setParallelism(Math.max(1, fallback - 1));
      });
  }, []);

  const [isProcessing, setIsProcessing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cancelRef = useRef(false);
  const runningSubIdRef = useRef<string | null>(null);
  const [submitQueue, setSubmitQueue] = useState<PendingSubmission[]>([]);
  const submitQueueRef = useRef<PendingSubmission[]>([]);
  const submitProcessorRunningRef = useRef(false);
  const cancelledSubmissionIdsRef = useRef<Set<string>>(new Set());
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ type: 'info' | 'success' | 'error', message: string } | null>(null);

  const [submissionsMap, setSubmissionsMap] = useState<Record<string, Submission[]>>({});
  const [selectedSubId, setSelectedSubId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'results' | 'code'>('results');
  const [detailReturnTab, setDetailReturnTab] = useState<'submissions' | 'stats'>('submissions');

  const [visData, setVisData] = useState<VisData | null>(null);
  const visDataRef = useRef<VisData | null>(null);
  const setVisDataSynced = (data: VisData | null) => {
    visDataRef.current = data;
    setVisData(data);
  };
  // タブを切り替えたらビジュアライザを自動的に閉じる
  useEffect(() => { setVisDataSynced(null); setCurrentVisSubId(null); }, [activeTab]);

  const [memos, setMemos] = useState<Record<string, string>>({});
  const [favorites, setFavorites] = useState<Set<number>>(new Set());
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [submissionFavorites, setSubmissionFavorites] = useState<Set<string>>(new Set());
  const [showSubmissionFavoritesOnly, setShowSubmissionFavoritesOnly] = useState(false);
  const [submitMode, setSubmitMode] = useState<'regular' | 'favorites' | 'filtered'>('regular');
  const [submitVarFilters, setSubmitVarFilters] = useState<Record<string, { min: number | '', max: number | '' }>>({});

  const toggleFavorite = async (caseId: number) => {
    if (!currentContest) return;
    const next = new Set(favorites);
    if (next.has(caseId)) { next.delete(caseId); } else { next.add(caseId); }
    setFavorites(next);
    try { await invoke('save_testcase_favorites', { contestName: currentContest, favorites: Array.from(next) }); }
    catch (e) { console.error(e); }
  };

  const [config, setConfig] = useState<ContestConfig | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isGlobalSettingsOpen, setIsGlobalSettingsOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<ContestConfig | null>(null);

  const [testcaseVars, setTestcaseVars] = useState<Record<number, Record<string, number>>>({});

  // ★ ここから追加：ソートとスコア計算のための状態・処理
  // 提出一覧のソート状態
  const [submissionSort, setSubmissionSort] = useState<{ key: string; order: 'asc' | 'desc' }>({ key: 'timestamp', order: 'desc' });
  // テストケース一覧のソート状態
  const [testCaseSort, setTestCaseSort] = useState<{ key: string; order: 'asc' | 'desc' }>({ key: 'id', order: 'asc' });
  // テストケースごとの入出力展開状態
  const [expandedCaseIO, setExpandedCaseIO] = useState<Record<number, { input: string; output: string; stderr: string } | 'loading'>>({});
  const [relScoreTooltip, setRelScoreTooltip] = useState<RelScoreTooltip | null>(null);

  // ページネーション
  const [subPage, setSubPage] = useState(1);
  const [subPageSize, setSubPageSize] = useState(20);
  const [tcPage, setTcPage] = useState(1);
  const [tcPageSize, setTcPageSize] = useState(50);
  const [caseCountFilter, setCaseCountFilter] = useState<Set<number>>(new Set());

  // ★ 追加: 統計タブ用のState
  const [selectedForStats, setSelectedForStats] = useState<Set<string>>(new Set());
  const [varFilters, setVarFilters] = useState<Record<string, { min: number | '', max: number | '' }>>({});
  const [statsScoreMode, setStatsScoreMode] = useState<'absolute' | 'relative'>('absolute');
  const [statsSubPage, setStatsSubPage] = useState(1);
  const [statsSubPageSize, setStatsSubPageSize] = useState(20);
  const [statsSubmissionSort, setStatsSubmissionSort] = useState<{ key: string; order: 'asc' | 'desc' }>({ key: 'timestamp', order: 'desc' });
  // 統計グラフ上のポイントhoverツールチップ
  const [statsPointTooltip, setStatsPointTooltip] = useState<HoverInfo | null>(null);
  const [currentVisId, setCurrentVisId] = useState<number | null>(null);
  const [currentVisSubId, setCurrentVisSubId] = useState<string | null>(null);
  const [visZoom, setVisZoom] = useState(90);
  const [seedRange, setSeedRange] = useState<{ min: number | ''; max: number | '' }>({ min: '', max: '' });
  // クリック時に最新のホバー点を確実に参照するための ref（state は非同期なので不確実）
  const hoveredPointRef = React.useRef<{ id: number } | null>(null);

  // ② ソートされたコンテスト一覧を自動計算
  const sortedContests = useMemo(() => {
    return [...contests].sort((a, b) => {
      if (sortType === 'date') {
        return b.updated_at - a.updated_at; // 新しい順
      } else {
        return a.name.localeCompare(b.name); // 名前順（A-Z）
      }
    });
  }, [contests, sortType]);

  const updateQueueState = (updater: (prev: PendingSubmission[]) => PendingSubmission[]) => {
    const next = updater(submitQueueRef.current);
    submitQueueRef.current = next;
    setSubmitQueue(next);
  };

  const updateContestSubmissions = (contestName: string, updater: (list: Submission[]) => Submission[], persist = false) => {
    setSubmissionsMap(prev => {
      const list = prev[contestName] || [];
      const newList = normalizeSubmissionNumbers(updater(list));
      if (persist) saveSubmissions(contestName, newList);
      return { ...prev, [contestName]: newList };
    });
  };

  const isAcceptedResult = (tc: TestCaseResult) => tc.status === 'AC';

  // ★ 追加: コンテストが切り替わったら統計の選択状態をリセットする
  useEffect(() => {
    setSelectedForStats(new Set());
    setVarFilters({});
    setStatsScoreMode('absolute');
    setStatsSubPage(1);
    setSeedRange({ min: '', max: '' });
    setShowSubmissionFavoritesOnly(false);
  }, [currentContest]);

  useEffect(() => {
    setSubmitMode('regular');
    setSubmitVarFilters({});
  }, [currentContest]);

  // 提出の選択が変わったら展開中のIOをリセット
  useEffect(() => {
    setExpandedCaseIO({});
    setTcPage(1);
  }, [selectedSubId]);

  // submissions を先に計算
  const submissions = currentContest ? (submissionsMap[currentContest] || []) : [];
  const currentQueuedCount = currentContest ? submitQueue.filter(item => item.contestName === currentContest).length : 0;
  const currentRunningSubmissionId = currentContest
    ? (runningSubIdRef.current && submissions.some(sub => sub.id === runningSubIdRef.current) ? runningSubIdRef.current : null)
    : null;
  const currentCancellableSubmissionId = currentRunningSubmissionId
    ?? (currentContest ? [...submitQueue].reverse().find(item => item.contestName === currentContest)?.id ?? null : null);

  // 1. 各テストケースの「ベストスコア」を全提出から算出する
  const bestScores = useMemo(() => {
    const best: Record<number, number> = {};
    if (!submissions || submissions.length === 0) return best;

    const isMin = config?.optimize_target === 'minimize';

    submissions.forEach(sub => {
      sub.testCases?.forEach(tc => {
        if (!isAcceptedResult(tc)) return;
        if (best[tc.id] === undefined) {
          best[tc.id] = tc.score;
        } else {
          best[tc.id] = isMin ? Math.min(best[tc.id], tc.score) : Math.max(best[tc.id], tc.score);
        }
      });
    });
    return best;
  }, [submissions, config?.optimize_target]);

  // 2. 相対スコアを計算する関数
  const calcRelativeScore = (tc: TestCaseResult, bestScore: number | undefined) => {
    if (!isAcceptedResult(tc) || bestScore === undefined) return 0;
    const isMin = config?.optimize_target === 'minimize';
    // ご要望の計算式: 10^5 * ...
    const rel = isMin
      ? 1e5 * (1 + bestScore) / (1 + tc.score)
      : 1e5 * (1 + tc.score) / (1 + bestScore);
    return Math.round(rel);
  };

  const getScoreByMode = (tc: TestCaseResult, mode: 'absolute' | 'relative') => {
    if (mode === 'relative') return calcRelativeScore(tc, bestScores[tc.id]);
    return tc.score;
  };

  const passesAbsoluteScoreFilter = (tc: TestCaseResult, filters: Record<string, { min: number | '', max: number | '' }>) => {
    const scoreFilterMin = filters[SCORE_FILTER_KEY]?.min;
    const scoreFilterMax = filters[SCORE_FILTER_KEY]?.max;
    if (typeof scoreFilterMin === 'number' && tc.score < scoreFilterMin) return false;
    if (typeof scoreFilterMax === 'number' && tc.score > scoreFilterMax) return false;
    return true;
  };

  const passesVariableFilters = (
    tc: TestCaseResult,
    variableNames: string[],
    testcaseVarsMap: Record<number, Record<string, number>>,
    filters: Record<string, { min: number | '', max: number | '' }>,
  ) => {
    for (const name of variableNames) {
      const value = testcaseVarsMap[tc.id]?.[name];
      if (value === undefined) continue;
      const fMin = filters[name]?.min;
      const fMax = filters[name]?.max;
      if (typeof fMin === 'number' && value < fMin) return false;
      if (typeof fMax === 'number' && value > fMax) return false;
    }
    return true;
  };

  const getActiveContestVariables = () => {
    const vars = Object.keys(testcaseVars[0] || {});
    return vars.filter(v => {
      const firstVal = testcaseVars[0]?.[v];
      return Object.values(testcaseVars).some(tc => tc[v] !== firstVal);
    });
  };
  const submitActiveVars = getActiveContestVariables();
  const isCustomSubmitMode = submitMode !== 'regular';
  const hasSubmitVarCondition = Object.values(submitVarFilters).some(range => typeof range?.min === 'number' || typeof range?.max === 'number');
  const maxRelativeScore = 100000;

  const toggleSubmissionFavorite = (submissionId: string) => {
    if (!currentContest) return;
    setSubmissionFavorites(prev => {
      const next = new Set(prev);
      if (next.has(submissionId)) next.delete(submissionId);
      else next.add(submissionId);
      localStorage.setItem(`heu_submission_favorites_${currentContest}`, JSON.stringify(Array.from(next)));
      return next;
    });
  };

  const openSubmissionDetail = (submissionId: string, returnTab: 'submissions' | 'stats') => {
    setDetailReturnTab(returnTab);
    setSelectedSubId(submissionId);
    setDetailTab('results');
    setActiveTab('submissions');
  };

  const closeSubmissionDetail = () => {
    setSelectedSubId(null);
    setDetailTab('results');
    if (detailReturnTab === 'stats') {
      setActiveTab('stats');
    }
  };

  // 3. 提出一覧（ソート＆相対スコア合計付き）
  const sortedSubmissions = useMemo(() => {
    if (!submissions) return [];
    const useAverageScore = config?.score_display === 'average';

    const mapped = submissions.map(sub => {
      const cases = sub.testCases ?? [];
      const totalRelScore = cases.reduce((acc, tc) => acc + calcRelativeScore(tc, bestScores[tc.id]), 0);
      const uniqueCaseCount = cases.reduce((acc, tc) => acc + (calcRelativeScore(tc, bestScores[tc.id]) === maxRelativeScore ? 1 : 0), 0);
      const n = cases.length || 1;
      const avgScore = sub.totalScore / n;
      const avgRelScore = totalRelScore / n;
      const displayScore = useAverageScore ? avgScore : sub.totalScore;
      return { ...sub, totalRelScore, uniqueCaseCount, _avgScore: avgScore, _avgRelScore: avgRelScore, _displayScore: displayScore };
    });

    return mapped.sort((a, b) => {
      let valA: number, valB: number;
      if (submissionSort.key === 'totalScore') {
        valA = a._displayScore; valB = b._displayScore;
      } else if (submissionSort.key === 'avgRelScore') {
        valA = a._avgRelScore; valB = b._avgRelScore;
      } else {
        valA = a[submissionSort.key as keyof typeof a] as any;
        valB = b[submissionSort.key as keyof typeof b] as any;
      }
      if (valA < valB) return submissionSort.order === 'asc' ? -1 : 1;
      if (valA > valB) return submissionSort.order === 'asc' ? 1 : -1;
      return 0;
    });
  }, [submissions, submissionSort, bestScores, config?.optimize_target, config?.score_display]);
  // ★ ここまで追加

  const statsSortedSubmissions = useMemo(() => {
    const copied = [...sortedSubmissions];
    return copied.sort((a: any, b: any) => {
      let valA: number | string = a[statsSubmissionSort.key as keyof typeof a] as any;
      let valB: number | string = b[statsSubmissionSort.key as keyof typeof b] as any;
      if (statsSubmissionSort.key === 'totalScore') {
        valA = a._displayScore;
        valB = b._displayScore;
      } else if (statsSubmissionSort.key === 'avgRelScore') {
        valA = a._avgRelScore;
        valB = b._avgRelScore;
      }
      if (valA < valB) return statsSubmissionSort.order === 'asc' ? -1 : 1;
      if (valA > valB) return statsSubmissionSort.order === 'asc' ? 1 : -1;
      return 0;
    });
  }, [sortedSubmissions, statsSubmissionSort]);

  const getBestSubmissionsForCase = (caseId: number) => {
    const bestScore = bestScores[caseId];
    if (bestScore === undefined) return { bestScore: 0, winners: [] as { id: string; name: string; score: number }[] };
    const winners = submissions
      .map(sub => {
        const tc = sub.testCases?.find(t => t.id === caseId);
        return tc && isAcceptedResult(tc) && tc.score === bestScore ? { id: sub.id, name: sub.name, score: tc.score } : null;
      })
      .filter((entry): entry is { id: string; name: string; score: number } => entry !== null);
    return { bestScore, winners };
  };

  const persistTuningSessions = (sessions: TuningSession[], contestName: string) => {
    localStorage.setItem(`heu_tuning_sessions_${contestName}`, JSON.stringify(sessions));
  };

  const upsertTuningSession = (session: TuningSession) => {
    if (!currentContest) return;
    setTuningSessions(prev => {
      const next = [session, ...prev.filter(s => s.id !== session.id)]
        .sort((a, b) => b.savedAt - a.savedAt)
        .slice(0, 30);
      persistTuningSessions(next, currentContest);
      return next;
    });
    setSelectedTuningSessionId(session.id);
  };

  const snapshotCurrentTuningSession = (sessionId: string, override?: Partial<TuningSession>) => {
    const session: TuningSession = {
      id: sessionId,
      name: override?.name ?? `履歴 ${new Date().toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
      savedAt: override?.savedAt ?? Date.now(),
      code: override?.code ?? tuningCode,
      params: override?.params ?? tuningParams,
      testCases: override?.testCases ?? tuningTestCases,
      history: override?.history ?? tuningHistory,
      best: override?.best ?? tuningBest,
    };
    upsertTuningSession(session);
  };

  const renameTuningSession = (sessionId: string, name: string) => {
    if (!currentContest) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setTuningSessions(prev => {
      const next = prev.map(session => session.id === sessionId ? { ...session, name: trimmed, savedAt: Date.now() } : session);
      persistTuningSessions(next, currentContest);
      return next;
    });
  };

  const deleteTuningSession = (sessionId: string) => {
    if (!currentContest) return;
    setTuningSessions(prev => {
      const next = prev.filter(session => session.id !== sessionId);
      persistTuningSessions(next, currentContest);
      return next;
    });
    if (selectedTuningSessionId === sessionId) setSelectedTuningSessionId(null);
  };

  const canResumeSelectedTuningSession = useMemo(() => {
    if (!selectedTuningSessionId || tuningHistory.length === 0) return false;
    const session = tuningSessions.find(s => s.id === selectedTuningSessionId);
    if (!session) return false;
    return JSON.stringify({
      code: tuningCode,
      testCases: tuningTestCases,
      params: normalizeTuningParamsForCompare(tuningParams),
    }) === JSON.stringify({
      code: session.code,
      testCases: session.testCases,
      params: normalizeTuningParamsForCompare(session.params),
    });
  }, [selectedTuningSessionId, tuningSessions, tuningHistory, tuningCode, tuningTestCases, tuningParams]);

  const tuningTotalCombos = useMemo(() => {
    if (tuningParams.length === 0) return 0;
    return tuningParams.reduce((acc, param) => acc * buildTuningDiscreteValues(param).length, 1);
  }, [tuningParams]);

  const handleSubmissionSort = (key: string) => {
    setSubmissionSort(prev => ({
      key, order: prev.key === key && prev.order === 'desc' ? 'asc' : 'desc'
    }));
    setSubPage(1);
  };

  const handleTestCaseSort = (key: string) => {
    setTestCaseSort(prev => ({
      key, order: prev.key === key && prev.order === 'desc' ? 'asc' : 'desc'
    }));
    setTcPage(1);
  };

  const handleStatsSubmissionSort = (key: string) => {
    setStatsSubmissionSort(prev => ({
      key, order: prev.key === key && prev.order === 'desc' ? 'asc' : 'desc'
    }));
    setStatsSubPage(1);
  };

  useEffect(() => { loadContests(); }, []);

  const scoreDisplayMode = config?.score_display === 'average' ? 'average' : 'sum';
  const scoreColumnLabel = scoreDisplayMode === 'average' ? '平均得点' : '得点';
  const visScale = visZoom / 100;
  const visOuterScale = Math.max(visScale, 1);
  const visInnerBase = visScale < 1 ? 100 / visScale : 100;
  const formatSubmissionScore = (sub: { totalScore: number; testCases?: TestCaseResult[]; _displayScore?: number }) => {
    const value = sub._displayScore ?? (scoreDisplayMode === 'average'
      ? sub.totalScore / Math.max(1, sub.testCases?.length || 0)
      : sub.totalScore);
    return value.toLocaleString(undefined, scoreDisplayMode === 'average'
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : { maximumFractionDigits: 0 });
  };

  useEffect(() => {
    if (!currentContest) {
      setLanguage('cpp');
      setCode(DEFAULT_CODE['cpp']);
      return;
    }
    try {
      const saved = editorStateKey ? localStorage.getItem(editorStateKey) : null;
      if (saved) {
        const parsed = JSON.parse(saved);
        const nextLanguage = parsed.language && DEFAULT_CODE[parsed.language] ? parsed.language : 'cpp';
        setLanguage(nextLanguage);
        setCode(typeof parsed.code === 'string' ? parsed.code : DEFAULT_CODE[nextLanguage]);
      } else {
        setLanguage('cpp');
        setCode(DEFAULT_CODE['cpp']);
      }
    } catch {
      setLanguage('cpp');
      setCode(DEFAULT_CODE['cpp']);
    }
  }, [currentContest]);

  useEffect(() => {
    if (!editorStateKey) return;
    localStorage.setItem(editorStateKey, JSON.stringify({ language, code }));
  }, [editorStateKey, language, code]);

  // ── コンテストごとの制限値・チューニング設定をlocalStorageから復元 ──
  const limitsLoadedRef = useRef(false);
  useEffect(() => {
    if (!currentContest) { limitsLoadedRef.current = false; return; }
    limitsLoadedRef.current = false;
    try {
      const saved = localStorage.getItem(`heu_limits_${currentContest}`);
      if (saved) {
        const { testCases: tc, timeLimit: tl, memoryLimit: ml } = JSON.parse(saved);
        if (tc != null) setTestCases(tc);
        if (tl != null) setTimeLimit(tl);
        if (ml != null) setMemoryLimit(ml);
      }
      const savedTuning = localStorage.getItem(`heu_tuning_${currentContest}`);
      if (savedTuning) {
        const { params, testCases: ttc, code: savedCode, selectedSessionId } = JSON.parse(savedTuning);
        if (params) setTuningParams(params.map((p: TuningParam) => ({ ...p, divisions: p.divisions ?? 5 })));
        if (ttc != null) setTuningTestCases(ttc);
        if (savedCode != null) setTuningCode(savedCode);
        if (selectedSessionId != null) setSelectedTuningSessionId(selectedSessionId);
      } else {
        setTuningCode(code);
      }
      const savedSessions = localStorage.getItem(`heu_tuning_sessions_${currentContest}`);
      if (savedSessions) {
        setTuningSessions(JSON.parse(savedSessions).map((session: TuningSession) => ({
          ...session,
          params: session.params.map(p => ({ ...p, divisions: p.divisions ?? 5 })),
        })));
      } else {
        setTuningSessions([]);
      }
    } catch {}
    setTimeout(() => { limitsLoadedRef.current = true; }, 150);
  }, [currentContest]);

  useEffect(() => {
    if (!currentContest || !limitsLoadedRef.current) return;
    localStorage.setItem(`heu_limits_${currentContest}`, JSON.stringify({ testCases, timeLimit, memoryLimit }));
  }, [testCases, timeLimit, memoryLimit, currentContest]);

  useEffect(() => {
    if (!currentContest || !limitsLoadedRef.current) return;
    localStorage.setItem(`heu_tuning_${currentContest}`, JSON.stringify({
      params: tuningParams,
      testCases: tuningTestCases,
      code: tuningCode,
      selectedSessionId: selectedTuningSessionId,
    }));
  }, [tuningParams, tuningTestCases, tuningCode, selectedTuningSessionId, currentContest]);

  useEffect(() => {
    if (!tuningCode) setTuningCode(code);
  }, [code, tuningCode]);

  useEffect(() => {
    tuningHistoryRef.current = tuningHistory;
  }, [tuningHistory]);
  useEffect(() => {
    if (currentContest) {
      invoke<ContestConfig>('get_contest_config', { contestName: currentContest })
        .then(data => setConfig(data))
        .catch(e => console.error("設定読み込みエラー:", e));
      invoke<Record<string, string>>('get_testcase_memos', { contestName: currentContest })
        .then(data => setMemos(data))
        .catch(console.error);
      invoke<number[]>('get_testcase_favorites', { contestName: currentContest })
        .then(data => setFavorites(new Set(data)))
        .catch(console.error);
      try {
        const raw = localStorage.getItem(`heu_submission_favorites_${currentContest}`);
        setSubmissionFavorites(new Set(raw ? JSON.parse(raw) : []));
      } catch {
        setSubmissionFavorites(new Set());
      }
    } else {
      setConfig(null);
      setSubmissionFavorites(new Set());
    }
  }, [currentContest]);

  useEffect(() => {
    if (currentContest && config?.variables) {
      invoke<Record<number, Record<string, number>>>('get_testcase_variables', { contestName: currentContest })
        .then(data => {
          setTestcaseVars(data);
          console.log("読み込んだ変数データ:", data);
        })
        .catch(e => console.error("変数読み込みエラー:", e));
    } else {
      setTestcaseVars({});
    }
  }, [currentContest, config?.variables]);

  const openSettings = () => {
    if (config) {
      setEditingConfig({ ...config });
      setIsSettingsOpen(true);
    }
  };

  const openGlobalSettings = () => {
    setIsGlobalSettingsOpen(true);
  };

  const saveSettings = async () => {
    if (!currentContest || !editingConfig) return;
    try {
      // ★ 追加: コンテスト名が変更された場合の処理
      const newName = editingConfig.name.trim();
      const nextConfig = { ...editingConfig, name: newName || currentContest, score_display: editingConfig.score_display ?? 'sum' };
      if (newName && newName !== currentContest) {
        await invoke('rename_contest', { oldName: currentContest, newName: newName });

        // 画面上のリストや現在のコンテスト名も新しいものに更新
        setContests(prev => prev.map(c =>
          c.name === currentContest ? { ...c, name: newName, updated_at: Math.floor(Date.now() / 1000) } : c
        ));
        setCurrentContest(newName);
      }

      // 既存の設定保存処理（リネームされている可能性があるので newName を使う）
      await invoke('save_contest_config', { contestName: newName || currentContest, config: nextConfig });

      setConfig(nextConfig);
      setIsSettingsOpen(false);
      showStatus('success', '設定を保存しました');
    } catch (e) {
      console.error("設定保存エラー:", e);
      showStatus('error', '設定の保存に失敗しました: ' + String(e));
    }
  };

  const handleSelectToolsZip = async () => {
    if (!currentContest) return;
    try {
      const selectedPath = await open({
        directory: false,
        multiple: false,
        filters: [{ name: 'ZIP Files', extensions: ['zip'] }],
        title: "toolsのZIPファイルを選択してください",
        defaultPath: dialogDefaultPath || undefined,
      });

      if (selectedPath && typeof selectedPath === 'string') {
        setIsProcessing(true);
        showStatus('info', 'ZIPを展開しています...');
        await invoke('update_tools_from_zip', { contestName: currentContest, zipPath: selectedPath });

        showStatus('success', 'toolsを更新しました！');
      }
    } catch (e) {
      console.error("ZIP選択エラー:", e);
      showStatus('error', 'ZIPの展開に失敗しました: ' + String(e));
    } finally {
      setIsProcessing(false);
    }
  };

  useEffect(() => {
    if (currentContest) {
      invoke<string>('load_submissions', { contestName: currentContest })
        .then(res => {
          const parsed = normalizeSubmissionNumbers(JSON.parse(res));
          setSubmissionsMap(prev => ({ ...prev, [currentContest]: parsed }));
        }).catch(console.error);
    }
  }, [currentContest]);

  const saveSubmissions = async (contest: string, data: Submission[]) => {
    try { await invoke('save_submissions', { contestName: contest, data: JSON.stringify(data) }); }
    catch (e) { console.error(e); }
  };

  const refreshTestcaseVariables = async (contestName: string) => {
    const data = await invoke<Record<number, Record<string, number>>>('get_testcase_variables', { contestName });
    setTestcaseVars(data);
    return data;
  };

  const showStatus = (type: 'info' | 'success' | 'error', message: string) => {
    setStatus({ type, message });
    if (type === 'success' || type === 'info') setTimeout(() => setStatus(null), 5000);
  };

  const loadContests = async () => {
    try { const list = await invoke<ContestItem[]>('get_contests'); setContests(list); } catch (e) { console.error(e); }
  };

  const handleCreateContest = async () => {
    if (!newContestName.trim()) { showStatus('error', 'コンテスト名を入力してください'); return; }
    try {
      const selected = await open({ multiple: false, filters: [{ name: 'ZIP', extensions: ['zip'] }], defaultPath: dialogDefaultPath || undefined });
      if (!selected || typeof selected !== 'string') return;

      setIsProcessing(true);
      showStatus('info', `${newContestName} の環境を構築中...`);
      const result = await invoke<string>('create_contest', {
        name: newContestName.trim(),
        zipPath: selected,
        optimizeTarget: newOptimizeTarget,
        variables: newVariables
      });
      showStatus('success', result);
      setNewContestName('');
      setNewOptimizeTarget('maximize');
      setNewVariables('');
      loadContests();
    } catch (error) { showStatus('error', String(error)); }
    finally { setIsProcessing(false); }
  };

  const handleMemoBlur = async (caseId: number, memo: string) => {
    if (!currentContest) return;
    try {
      await invoke('save_testcase_memo', { contestName: currentContest, caseId, memo });
      // 保存成功時に小さく通知を出しても良いかも（今回は省略）
    } catch (e) {
      showStatus('error', 'メモの保存に失敗しました: ' + String(e));
    }
  };

  const handleDeleteContest = async (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    showConfirm(
      `「${name}」を削除しますか？`,
      'ソースコードや実行結果もすべて消去されます。',
      async () => {
        setConfirmDialog(null);
        try {
          await invoke('delete_contest', { name });
          showStatus('success', `${name} を削除しました`);
          loadContests();
        } catch (error) { showStatus('error', String(error)); }
      }
    );
  };

  const archiveContest = (contestName: string, archived?: boolean) => {
    if (archived) return;
    const hasRunning = runningSubIdRef.current !== null && submissionsMap[contestName]?.some(sub => sub.id === runningSubIdRef.current);
    const hasQueued = submitQueueRef.current.some(item => item.contestName === contestName);
    if (hasRunning || hasQueued) {
      showStatus('error', '実行中または待機中の提出があるため、今はアーカイブできません');
      return;
    }

    showConfirm(
      `「${contestName}」をアーカイブしますか？`,
      'seedごとのIOや提出コードなどの重いデータを削除し、提出一覧と統計のみ閲覧可能にします。',
      async () => {
        setConfirmDialog(null);
        try {
          await invoke('archive_contest', { contestName });
          const nextConfig = currentContest === contestName && config ? { ...config, archived: true } : config;
          if (currentContest === contestName) {
            setConfig(nextConfig ?? null);
            setEditingConfig(nextConfig ?? null);
          }
          setContests(prev => prev.map(contest => contest.name === contestName ? { ...contest, archived: true, updated_at: Math.floor(Date.now() / 1000) } : contest));
          setSubmissionsMap(prev => {
            const list = prev[contestName] || [];
            return {
              ...prev,
              [contestName]: list.map(sub => ({
                ...sub,
                code: '',
                compileError: null,
                testCases: (sub.testCases || []).map(tc => ({ ...tc, error_msg: '' })),
              })),
            };
          });
          showStatus('success', 'アーカイブしました');
        } catch (error) {
          showStatus('error', String(error));
        }
      },
      'アーカイブ'
    );
  };

  const handleDeleteSubmission = (e: React.MouseEvent, subId: string) => {
    e.stopPropagation();
    const isRunning = runningSubIdRef.current === subId;
    const isQueued = submitQueueRef.current.some(item => item.id === subId);
    showConfirm(
      'この提出を削除しますか？',
      isRunning ? '現在実行中です。キャンセルしてから削除します。' : isQueued ? '待機中の提出です。待機列からも削除します。' : undefined,
      () => {
        setConfirmDialog(null);
        cancelledSubmissionIdsRef.current.add(subId);
        if (isRunning) cancelRef.current = true;
        if (isQueued) updateQueueState(prev => prev.filter(item => item.id !== subId));
        // バックグラウンドでディレクトリ削除（失敗しても無視）
        invoke('delete_submission_dir', { contestName: currentContest!, submissionId: subId }).catch(console.error);
        setSubmissionsMap(prev => {
          const list = prev[currentContest!] || [];
          const newList = list.filter(s => s.id !== subId);
          saveSubmissions(currentContest!, newList);
          return { ...prev, [currentContest!]: newList };
        });
        if (selectedSubId === subId) setSelectedSubId(null);
      }
    );
  };

  const handleGenerateInputs = async () => {
    if (!currentContest) return;
    setIsProcessing(true);
    showStatus('info', `テストケースを ${testCases} 個生成中...`);
    try {
      const result = await invoke<string>('generate_inputs', { contestName: currentContest, testCases });
      await refreshTestcaseVariables(currentContest);
      showStatus('success', result);
    } catch (error) { showStatus('error', String(error)); }
    finally { setIsProcessing(false); }
  };

  // ── 定数チューニング ──
  const stopTuning = () => {
    isTuningRef.current = false;
    shouldPauseTuningRef.current = false;
    if (tuningElapsedTimerRef.current) { clearInterval(tuningElapsedTimerRef.current); tuningElapsedTimerRef.current = null; }
    if (tuningSessionIdRef.current) snapshotCurrentTuningSession(tuningSessionIdRef.current, { savedAt: Date.now() });
    setTuningStatus('idle');
  };

  const startTuning = async () => {
    if (!currentContest || isTuningRef.current || tuningParams.length === 0) return;
    const isMaximize = config?.optimize_target !== 'minimize';
    const isBetter = (a: number, b: number) => isMaximize ? a > b : a < b;
    const shouldResume = canResumeSelectedTuningSession;
    const sessionId = shouldResume ? selectedTuningSessionId! : `tuning_session_${Date.now()}`;
    const grids = tuningParams.map(param => ({ param, values: buildTuningDiscreteValues(param) }));
    const candidateKey = (indices: number[]) => indices.join('|');
    const paramsFromIndices = (indices: number[]) => Object.fromEntries(
      grids.map((grid, i) => [grid.param.name, grid.values[indices[i]]])
    ) as Record<string, number>;
    const indicesFromResult = (result: TuningResult) => grids.map(grid => {
      const value = result.params[grid.param.name];
      const exact = grid.values.findIndex(v => v === value);
      if (exact >= 0) return exact;
      let bestIdx = 0;
      let bestDist = Infinity;
      grid.values.forEach((v, i) => {
        const dist = Math.abs(v - value);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      });
      return bestIdx;
    });
    const allOptions = grids.map(grid => grid.values.map((_, idx) => idx));
    const coarseOptions = grids.map(grid => {
      if (grid.values.length <= 3) return grid.values.map((_, idx) => idx);
      return Array.from(new Set([0, Math.floor((grid.values.length - 1) / 2), grid.values.length - 1]));
    });
    const evaluatedKeys = new Set<string>();
    const coarseResults: { indices: number[]; score: number }[] = [];

    isTuningRef.current = true;
    shouldPauseTuningRef.current = false;
    tuningPausedRef.current = false;
    tuningSessionIdRef.current = sessionId;
    tuningBestRef.current = shouldResume ? tuningBest : null;
    setTuningStatus('running');
    if (!shouldResume) {
      setTuningIterCount(0);
      setTuningBest(null);
      setTuningHistory([]);
      tuningHistoryRef.current = [];
      setTuningAvgIterSec(null);
      setTuningElapsedSec(0);
    }
    tuningStartTimeRef.current = Date.now();

    if (tuningElapsedTimerRef.current) clearInterval(tuningElapsedTimerRef.current);
    tuningElapsedTimerRef.current = setInterval(() => {
      setTuningElapsedSec(Math.floor((Date.now() - tuningStartTimeRef.current) / 1000));
    }, 1000);

    let iterCount = shouldResume ? Math.max(0, ...tuningHistory.map(h => h.iteration)) : 0;
    const iterTimes: number[] = [];
    if (shouldResume) {
      tuningHistory.forEach(result => evaluatedKeys.add(candidateKey(indicesFromResult(result))));
    }

    const evalParams = async (params: Record<string, number>): Promise<number> => {
      const subId = `tuning_${Date.now()}`;
      const execArgs = tuningParams.map(p => {
        const value = params[p.name];
        return p.paramType === 'int' ? String(Math.round(value)) : String(value);
      });

      let totalScore = 0;
      const queue = Array.from({ length: tuningTestCases }, (_, i) => i);
      const concurrency = Math.max(1, Math.floor(parallelism));
      const runQ = async (q: number[]) => {
        while (q.length > 0 && isTuningRef.current && !shouldPauseTuningRef.current) {
          const i = q.shift();
          if (i === undefined) break;
          try {
            const res = await invoke<TestCaseResult>('run_test_case', {
              contestName: currentContest, language, caseId: i,
              timeLimit, memoryLimit, submissionId: subId, execArgs,
            });
            totalScore += res.score;
          } catch {}
        }
      };
      const workers = Array.from({ length: concurrency }, () => runQ(queue));
      await Promise.all(workers);
      return totalScore;
    };

    try {
      await invoke('setup_submission', { contestName: currentContest, code: tuningCode, language, testCases: tuningTestCases });
    } catch (e) {
      if (tuningElapsedTimerRef.current) { clearInterval(tuningElapsedTimerRef.current); tuningElapsedTimerRef.current = null; }
      setTuningStatus('idle');
      isTuningRef.current = false;
      showStatus('error', String(e));
      return;
    }

    if (!shouldResume) {
      snapshotCurrentTuningSession(sessionId, {
        savedAt: Date.now(),
        code: tuningCode,
        params: tuningParams,
        testCases: tuningTestCases,
        history: [],
        best: null,
      });
    }

    const waitIfPaused = async () => {
      if (shouldPauseTuningRef.current) {
        tuningPausedRef.current = true;
        setTuningStatus('paused');
        while (shouldPauseTuningRef.current && isTuningRef.current) {
          await new Promise(r => setTimeout(r, 150));
        }
        tuningPausedRef.current = false;
        if (!isTuningRef.current) return false;
        setTuningStatus('running');
      }
      return isTuningRef.current;
    };

    const registerResult = (indices: number[], params: Record<string, number>, score: number, avgTime: number, stage: 'coarse' | 'focus' | 'full') => {
      iterCount++;
      const prevBest = tuningBestRef.current;
      const improved = prevBest === null || isBetter(score, prevBest.score);
      let bestSnapshot = tuningBestRef.current;
      if (improved) {
        const best: TuningResult = { iteration: iterCount, params: { ...params }, score, timestamp: Date.now() };
        tuningBestRef.current = best;
        bestSnapshot = best;
        setTuningBest(best);
      }

      const iter: TuningResult = { iteration: iterCount, params: { ...params }, score, timestamp: Date.now() };
      const nextHistory = [iter, ...tuningHistoryRef.current].slice(0, 100);
      tuningHistoryRef.current = nextHistory;
      setTuningHistory(nextHistory);
      setTuningIterCount(iterCount);
      setTuningAvgIterSec(avgTime);
      evaluatedKeys.add(candidateKey(indices));
      if (stage === 'coarse') coarseResults.push({ indices: [...indices], score });
      snapshotCurrentTuningSession(sessionId, {
        savedAt: Date.now(),
        code: tuningCode,
        params: tuningParams.map(p => ({ ...p })),
        testCases: tuningTestCases,
        history: nextHistory,
        best: bestSnapshot,
      });
    };

    const visitCombinations = async (indexOptions: number[][], stage: 'coarse' | 'focus' | 'full') => {
      const walk = async (depth: number, indices: number[]) => {
        if (!isTuningRef.current) return;
        if (!(await waitIfPaused())) return;
        if (depth === indexOptions.length) {
          const key = candidateKey(indices);
          if (evaluatedKeys.has(key)) return;
          const iterStart = Date.now();
          const params = paramsFromIndices(indices);
          let score = 0;
          try { score = await evalParams(params); } catch { return; }
          if (!isTuningRef.current) return;
          iterTimes.push((Date.now() - iterStart) / 1000);
          const avgTime = iterTimes.slice(-10).reduce((a, b) => a + b, 0) / Math.min(iterTimes.length, 10);
          registerResult(indices, params, score, avgTime, stage);
          return;
        }
        for (const idx of indexOptions[depth]) {
          indices.push(idx);
          await walk(depth + 1, indices);
          indices.pop();
          if (!isTuningRef.current) return;
        }
      };
      await walk(0, []);
    };

    await visitCombinations(coarseOptions, 'coarse');
    if (isTuningRef.current) {
      const topSeeds = [...coarseResults]
        .sort((a, b) => isMaximize ? b.score - a.score : a.score - b.score)
        .slice(0, Math.min(5, coarseResults.length));
      for (const seed of topSeeds) {
        const focusOptions = grids.map((grid, i) => {
          const center = seed.indices[i];
          return Array.from(new Set([center - 1, center, center + 1].filter(idx => idx >= 0 && idx < grid.values.length)));
        });
        await visitCombinations(focusOptions, 'focus');
        if (!isTuningRef.current) break;
      }
    }
    if (isTuningRef.current) await visitCombinations(allOptions, 'full');

    if (tuningElapsedTimerRef.current) { clearInterval(tuningElapsedTimerRef.current); tuningElapsedTimerRef.current = null; }
    setTuningStatus('idle');
    isTuningRef.current = false;
    if (iterCount > 0 && !shouldPauseTuningRef.current) showStatus('success', '段階的総当たりチューニングが完了しました');
  };

  const loadTuningSession = (session: TuningSession) => {
    if (isTuningRef.current) return;
    setSelectedTuningSessionId(session.id);
    setTuningCode(session.code);
    setTuningParams(session.params.map(p => ({ ...p, divisions: p.divisions ?? 5 })));
    setTuningTestCases(session.testCases);
    setTuningHistory(session.history);
    tuningHistoryRef.current = session.history;
    setTuningBest(session.best);
    tuningBestRef.current = session.best;
    setTuningIterCount(Math.max(0, ...session.history.map(h => h.iteration)));
    setTuningAvgIterSec(null);
    setTuningElapsedSec(0);
    showStatus('success', `履歴「${session.name}」を読み込みました`);
  };

  const collectFilteredCaseIds = async () => {
    if (!currentContest) return { caseIds: [] as number[], setupTestCases: testCases, executionTag: null as string | null };

    if (submitMode === 'favorites') {
      const caseIds = Array.from(favorites).sort((a, b) => a - b).slice(0, Math.min(testCases, favorites.size));
      return {
        caseIds,
        setupTestCases: Math.max(testCases, caseIds.length > 0 ? Math.max(...caseIds) + 1 : testCases),
        executionTag: caseIds.length > 0 ? `お気に入り実行 (${caseIds.length}件)` : 'お気に入り実行 (0件)',
      };
    }

    if (submitMode !== 'filtered') {
      return {
        caseIds: Array.from({ length: testCases }, (_, i) => i),
        setupTestCases: testCases,
        executionTag: null,
      };
    }

    const variableNames = getActiveContestVariables();
    if (variableNames.length === 0 && Object.keys(submitVarFilters).length === 0) {
      return {
        caseIds: Array.from({ length: testCases }, (_, i) => i),
        setupTestCases: testCases,
        executionTag: null,
      };
    }

    const startAt = Date.now();
    let poolSize = Math.max(testCases, Object.keys(testcaseVars).length || testCases);
    let currentVars = await refreshTestcaseVariables(currentContest);
    const pick = (varsMap: Record<number, Record<string, number>>) => Array
      .from({ length: poolSize }, (_, i) => i)
      .filter((id) => {
        const tc: TestCaseResult = { id, score: 0, status: 'WA', time: 0, error_msg: '' };
        return passesVariableFilters(tc, variableNames, varsMap, submitVarFilters);
      })
      .slice(0, testCases);

    let caseIds = pick(currentVars);
    while (caseIds.length < testCases && Date.now() - startAt < 30000) {
      poolSize += Math.max(50, testCases);
      showStatus('info', `条件に合うケースを探索中... (${poolSize} 件まで生成)`);
      await invoke<string>('generate_inputs', { contestName: currentContest, testCases: poolSize });
      currentVars = await refreshTestcaseVariables(currentContest);
      caseIds = pick(currentVars);
    }

    return {
      caseIds,
      setupTestCases: poolSize,
      executionTag: `条件絞り込み実行 (${caseIds.length}件)`,
    };
  };

  const cancelSubmission = (subId: string) => {
    cancelledSubmissionIdsRef.current.add(subId);
    if (runningSubIdRef.current === subId) {
      cancelRef.current = true;
      showStatus('info', '実行中の提出をキャンセルしています...');
      return;
    }
    updateQueueState(prev => prev.filter(item => item.id !== subId));
    if (currentContest) {
      updateContestSubmissions(currentContest, list => list.map(sub => sub.id === subId ? { ...sub, status: 'Cancelled' } : sub), true);
    } else {
      setSubmissionsMap(prev => {
        const next = { ...prev };
        Object.keys(next).forEach(contestName => {
          const list = next[contestName] || [];
          const updated = list.map(sub => sub.id === subId ? { ...sub, status: 'Cancelled' } : sub);
          if (updated !== list) {
            next[contestName] = updated;
            saveSubmissions(contestName, updated);
          }
        });
        return next;
      });
    }
  };

  const runSubmission = async (item: PendingSubmission) => {
    if (currentContest === item.contestName && isTuningRef.current) {
      shouldPauseTuningRef.current = true;
      const waitStart = Date.now();
      while (!tuningPausedRef.current && isTuningRef.current && Date.now() - waitStart < 8000) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    runningSubIdRef.current = item.id;
    cancelRef.current = false;
    updateContestSubmissions(item.contestName, list => list.map(s => s.id === item.id ? { ...s, status: 'Compiling...', compileError: null } : s));

    try {
      await invoke('setup_submission', {
        contestName: item.contestName,
        code: item.code,
        language: item.language,
        testCases: item.setupTestCases,
      });
    } catch (error) {
      const compileError = String(error);
      updateContestSubmissions(item.contestName, list => list.map(s => s.id === item.id ? { ...s, status: 'CE', compileError } : s), true);
      if (currentContest === item.contestName) {
        setSubmitError(compileError);
        setActiveTab('submit');
      }
      showStatus('error', `提出 ${item.id} のコンパイルに失敗しました`);
      return;
    }

    updateContestSubmissions(item.contestName, list => list.map(s => s.id === item.id ? { ...s, status: `Running... (0/${item.caseIds.length})` } : s));

    let runningScore = 0;
    let maxTime = 0;
    let completedCases = 0;
    const resultsArr: TestCaseResult[] = [];

    const updateRunningState = () => {
      updateContestSubmissions(item.contestName, list => list.map(s => (
        s.id === item.id
          ? { ...s, totalScore: runningScore, execTime: maxTime, status: `Running... (${completedCases}/${item.caseIds.length})`, testCases: [...resultsArr].sort((a, b) => a.id - b.id) }
          : s
      )));
    };

    const runQueue = async (queue: number[]) => {
      while (queue.length > 0) {
        if (cancelRef.current || cancelledSubmissionIdsRef.current.has(item.id)) break;
        const i = queue.shift();
        if (i === undefined) break;

        let res: TestCaseResult;
        try {
          res = await invoke<TestCaseResult>('run_test_case', {
            contestName: item.contestName,
            language: item.language,
            caseId: i,
            timeLimit: item.timeLimit,
            memoryLimit: item.memoryLimit,
            submissionId: item.id,
          });
        } catch (e) {
          res = { id: i, score: 0, status: 'IE', time: 0, error_msg: String(e) };
        }

        runningScore += res.score;
        maxTime = Math.max(maxTime, res.time);
        resultsArr.push(res);
        completedCases++;
        updateRunningState();
      }
    };

    const concurrency = Math.max(1, Math.floor(parallelism));
    const queue = [...item.caseIds];
    await Promise.all(Array.from({ length: concurrency }, () => runQueue(queue)));

    const cancelled = cancelRef.current || cancelledSubmissionIdsRef.current.has(item.id);
    const hasIE = resultsArr.some(r => r.status === 'IE');
    const hasMLE = resultsArr.some(r => r.status === 'MLE');
    const hasTLE = resultsArr.some(r => r.status === 'TLE');
    const hasRE = resultsArr.some(r => r.status === 'RE');
    const hasWA = resultsArr.some(r => r.status === 'WA');
    const finalStatus = cancelled ? `Cancelled (${completedCases}/${item.caseIds.length})` : hasIE ? 'IE' : hasMLE ? 'MLE' : hasTLE ? 'TLE' : hasRE ? 'RE' : hasWA ? 'WA' : 'AC';

    updateContestSubmissions(item.contestName, list => list.map(s => (
      s.id === item.id
        ? { ...s, status: finalStatus, totalScore: runningScore, execTime: maxTime, testCases: [...resultsArr].sort((a, b) => a.id - b.id) }
        : s
    )), true);

    if (cancelled) showStatus('info', `提出をキャンセルしました（${completedCases}件完了）`);
    else showStatus('success', `提出 ${item.id} の実行が完了しました`);
  };

  const processSubmissionQueue = async () => {
    if (submitProcessorRunningRef.current) return;
    submitProcessorRunningRef.current = true;

    try {
      while (submitQueueRef.current.length > 0) {
        const [next, ...rest] = submitQueueRef.current;
        submitQueueRef.current = rest;
        setSubmitQueue(rest);
        if (!next) break;
        if (cancelledSubmissionIdsRef.current.has(next.id)) continue;
        await runSubmission(next);
      }
    } finally {
      submitProcessorRunningRef.current = false;
      runningSubIdRef.current = null;
      cancelRef.current = false;
      shouldPauseTuningRef.current = false;
    }
  };

  const handleSubmit = async () => {
    if (!currentContest || config?.archived) return;
    if (submitMode === 'filtered' && submitActiveVars.length === 0) {
      showStatus('error', '変数絞り込みに使える変数がありません');
      return;
    }
    if (submitMode === 'filtered' && !hasSubmitVarCondition) {
      showStatus('error', '変数絞り込みの条件を1つ以上指定してください');
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const prepared = await collectFilteredCaseIds();
      if (prepared.caseIds.length === 0) {
        showStatus('error', submitMode === 'favorites' ? 'お気に入りケースがありません' : '条件に合うケースが見つかりませんでした');
        return;
      }
      const subId = Date.now().toString();
      const nextSubmissionNumber = submissions.reduce((max, sub) => Math.max(max, sub.submissionNumber ?? parseSubmissionNumberFromName(sub.name) ?? 0), 0) + 1;
      const newSub: Submission = {
        id: subId, timestamp: Date.now(),
        time: new Date().toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        name: `提出 ${nextSubmissionNumber}`, totalScore: 0, codeLength: new Blob([code]).size,
        status: 'WJ', execTime: 0, code: code, language: language, testCases: [], compileError: null, executionTag: prepared.executionTag,
        submissionNumber: nextSubmissionNumber,
      };

      updateContestSubmissions(currentContest, list => {
        const newList = [newSub, ...list];
        saveSubmissions(currentContest, newList);
        return newList;
      });
      updateQueueState(prev => [...prev, {
        id: subId,
        contestName: currentContest,
        code,
        language,
        caseIds: prepared.caseIds,
        setupTestCases: prepared.setupTestCases,
        timeLimit,
        memoryLimit,
        executionTag: prepared.executionTag,
      }]);
      setSelectedSubId(null);
      setActiveTab('submissions');
      if (runningSubIdRef.current || submitProcessorRunningRef.current || submitQueueRef.current.length > 1) {
        showStatus('info', '提出を待機列に追加しました');
      } else {
        showStatus('info', '提出を受け付けました');
      }
      void processSubmissionQueue();
    } finally {
      setIsSubmitting(false);
    }
  };

  const updateSubName = (id: string, newName: string) => {
    setSubmissionsMap(prev => {
      const list = prev[currentContest!] || [];
      const newList = list.map(sub => sub.id === id ? { ...sub, name: newName } : sub);
      saveSubmissions(currentContest!, newList);
      return { ...prev, [currentContest!]: newList };
    });
  };

  const openVisualizer = async (caseId: number, submissionId?: string) => {
    if (config?.archived) {
      showStatus('error', 'アーカイブ済みのためビジュアライザは利用できません');
      return;
    }
    setCurrentVisId(caseId);
    try {
      const data = await invoke<VisData>('get_visualizer_data', { contestName: currentContest, caseId, submissionId: submissionId ?? null });
      const current = visDataRef.current;
      if (current && current.local_url) {
        if (visIframeRef.current && visIframeRef.current.contentWindow) {
          visIframeRef.current.contentWindow.postMessage({
            type: 'UPDATE_VIS',
            input: data.input,
            output: data.output,
            seed: caseId.toString()
          }, '*');
        }
        setVisDataSynced({ ...data, local_url: current.local_url });
      } else {
        setVisDataSynced(data);
      }
    } catch (e) {
      showStatus('error', String(e));
    }
  };

  const toggleCaseIO = async (caseId: number, submissionId?: string) => {
    if (config?.archived) {
      showStatus('error', 'アーカイブ済みのため入出力は閲覧できません');
      return;
    }
    if (expandedCaseIO[caseId] !== undefined) {
      setExpandedCaseIO(prev => { const next = { ...prev }; delete next[caseId]; return next; });
      return;
    }
    setExpandedCaseIO(prev => ({ ...prev, [caseId]: 'loading' }));
    try {
      const data = await invoke<VisData>('get_visualizer_data', { contestName: currentContest, caseId, submissionId: submissionId ?? null });
      setExpandedCaseIO(prev => ({ ...prev, [caseId]: { input: data.input, output: data.output, stderr: data.stderr } }));
    } catch (e) {
      setExpandedCaseIO(prev => { const next = { ...prev }; delete next[caseId]; return next; });
      showStatus('error', String(e));
    }
  };

  const handleOpenWebVis = () => {
    if (!visData || !visData.web_url) return;
    const targetUrl = visData.web_url;
    navigator.clipboard.writeText(visData.output).then(() => {
      showStatus('success', '出力結果をクリップボードにコピーしました');
      window.open(targetUrl, '_blank');
    }).catch(() => {
      window.open(targetUrl, '_blank');
    });
  };

  const StatusBar = () => {
    if (!status) return null;
    const colors = { info: 'bg-blue-100 text-blue-800 border-blue-300', success: 'bg-green-100 text-green-800 border-green-300', error: 'bg-red-100 text-red-800 border-red-300' };
    const Icon = status.type === 'error' ? AlertCircle : status.type === 'success' ? CheckCircle2 : Loader2;
    return (
      <div className={`fixed bottom-4 right-4 p-4 rounded-lg shadow-lg border flex items-center gap-3 max-w-md animate-in slide-in-from-bottom-5 ${colors[status.type]} z-50`}>
        <Icon className={status.type === 'info' ? 'animate-spin min-w-[20px]' : 'min-w-[20px]'} size={20} />
        <p className="font-semibold whitespace-pre-wrap text-sm break-all">{status.message}</p>
        {status.type === 'error' && <button onClick={() => setStatus(null)} className="ml-auto underline text-xs font-bold px-2 py-1 min-w-max">閉じる</button>}
      </div>
    );
  };

  const getStatusBadge = (st: string) => {
    let color = 'bg-red-100 text-red-700 border-red-300';
    if (st === 'AC') color = 'bg-green-100 text-green-700 border-green-300';
    else if (st === 'WA') color = 'bg-yellow-100 text-yellow-700 border-yellow-300';
    else if (st === 'TLE') color = 'bg-orange-100 text-orange-700 border-orange-300';
    else if (st === 'MLE') color = 'bg-purple-100 text-purple-700 border-purple-300';
    else if (st === 'CE') color = 'bg-red-100 text-red-700 border-red-300';
    else if (st === 'WJ') color = 'bg-slate-100 text-slate-700 border-slate-300';
    else if (st.startsWith('Cancelled')) color = 'bg-gray-100 text-gray-700 border-gray-300';
    else if (st === 'Compiling...') color = 'bg-cyan-100 text-cyan-700 border-cyan-300';
    if (st.startsWith('Running')) return <span className="px-2 py-1 rounded text-xs font-bold border bg-blue-100 text-blue-700 border-blue-300 animate-pulse">{st}</span>;
    return <span className={`px-2 py-1 rounded text-xs font-bold border ${color}`}>{st}</span>;
  };

  // ★ スタート画面のど真ん中配置
  if (!currentContest) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 text-gray-800 font-sans p-8">
        <div className="w-full max-w-5xl">
          <h1 className="text-3xl font-bold mb-10 flex items-center justify-center gap-3">
            <Code2 size={32} className="text-blue-600" />AHC Local Virtual Submit
          </h1>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
              <h2 className="text-xl font-bold mb-4 flex items-center gap-2"><Plus size={24} className="text-green-600" />新しいコンテスト</h2>
              <div className="flex flex-col gap-4">
                <input type="text" value={newContestName} onChange={(e) => setNewContestName(e.target.value)} className="w-full border p-2 rounded focus:ring-2 focus:ring-blue-500" placeholder="ahc060" />

                {/* スコアの目標（最大化/最小化） */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">スコアの目標</label>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="optimize"
                        value="maximize"
                        checked={newOptimizeTarget === 'maximize'}
                        onChange={() => setNewOptimizeTarget('maximize')}
                        className="w-4 h-4 text-blue-600 focus:ring-blue-500"
                      />
                      <span>最大化</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="optimize"
                        value="minimize"
                        checked={newOptimizeTarget === 'minimize'}
                        onChange={() => setNewOptimizeTarget('minimize')}
                        className="w-4 h-4 text-blue-600 focus:ring-blue-500"
                      />
                      <span>最小化</span>
                    </label>
                  </div>
                </div>

                {/* 1行目の変数 */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">1行目の変数 (スペース区切り)</label>
                  <input
                    type="text"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="例: N M (空白なら省略)"
                    value={newVariables}
                    onChange={(e) => setNewVariables(e.target.value)}
                  />
                </div>

                <button disabled={isProcessing} onClick={handleCreateContest} className="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded disabled:opacity-50">tools.zip を選択して作成</button>
              </div>
            </div>

            <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
              <h2 className="text-xl font-bold mb-4 flex items-center gap-2"><Folder size={24} className="text-blue-600" />開く</h2>

              {/* ③ 並べ替えプルダウンの追加 */}
              <div className="flex justify-between items-center mb-4">
                <label className="text-sm font-medium text-gray-700">並べ替え:</label>
                <select
                  value={sortType}
                  onChange={(e) => setSortType(e.target.value as 'date' | 'name')}
                  className="border border-gray-300 rounded-md p-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="date">最終更新日時が新しい順</option>
                  <option value="name">名前順</option>
                </select>
              </div>

              <ul className="space-y-2">
                {sortedContests.map((contest) => (
                  <li key={contest.name} className="flex gap-2">
                    <button
                      onClick={() => setCurrentContest(contest.name)}
                      className="flex-1 text-left px-4 py-3 bg-white border border-gray-200 hover:border-blue-400 hover:bg-blue-50 rounded-lg transition-colors flex justify-between items-center group"
                    >
                      <span className="font-bold text-gray-800 group-hover:text-blue-700 transition-colors flex items-center gap-2">
                        {contest.name}
                        {contest.archived && <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">Archived</span>}
                        <Play size={16} className="text-gray-400 group-hover:text-blue-600" />
                      </span>

                      {/* ↓ ここに最終更新日時を追加！ ↓ */}
                      <span className="text-xs text-gray-400 flex items-center gap-1">
                        <Clock size={14} />
                        {formatTimestamp(contest.updated_at)}
                      </span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        archiveContest(contest.name, contest.archived);
                      }}
                      disabled={contest.archived}
                      className="p-3 text-amber-600 hover:bg-amber-50 border border-transparent hover:border-amber-200 rounded transition-colors disabled:opacity-40"
                      title={contest.archived ? 'アーカイブ済み' : 'アーカイブ'}
                    >
                      <Archive size={18} />
                    </button>
                    <button onClick={(e) => handleDeleteContest(e, contest.name)} className="p-3 text-red-500 hover:bg-red-50 border border-transparent hover:border-red-200 rounded transition-colors" title="削除">
                      <Trash2 size={18} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
        <StatusBar />
        {confirmDialog && (
          <ConfirmDialog
            message={confirmDialog.message}
            subMessage={confirmDialog.subMessage}
            confirmLabel={confirmDialog.confirmLabel}
            onConfirm={confirmDialog.onConfirm}
            onCancel={() => setConfirmDialog(null)}
          />
        )}
      </div>
    );
  }

  const selectedSub = submissions.find(s => s.id === selectedSubId);

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-gray-50 text-gray-800 font-sans">
      <header className="bg-gray-900 text-white p-3 shadow flex justify-between items-center flex-none">
        <div className="flex items-center gap-4">
          <button onClick={() => setCurrentContest(null)} className="hover:bg-gray-700 p-2 rounded"><ArrowLeft size={20} /></button>
          <h1 className="text-lg font-bold flex items-center gap-2"><Code2 size={20} />{currentContest}{config?.archived && <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-200 text-amber-950">Archived</span>}</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openGlobalSettings}
            className="px-4 py-2 bg-white/10 hover:bg-white/15 text-white rounded-lg flex items-center gap-2 font-bold transition-colors"
          >
            <Settings size={18} /> グローバル設定
          </button>
          <button
            disabled={isProcessing || !currentContest}
            onClick={openSettings}
            className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg flex items-center gap-2 font-bold transition-colors disabled:opacity-50"
          >
            <Settings size={18} /> コンテスト設定
          </button>
        </div>
      </header>

      <div className="bg-white border-b border-gray-200 px-6 flex gap-1 pt-3 flex-none">
        {/* ★ コード提出に戻る時に setVisData(null) を追加して閉じるようにしました */}
        <button onClick={() => { setActiveTab('submit'); setVisDataSynced(null); }} className={`px-4 py-2 rounded-t-lg font-bold border-t border-l border-r ${activeTab === 'submit' ? 'bg-white text-blue-600 border-gray-200 -mb-px' : 'bg-gray-100 text-gray-500 border-transparent hover:bg-gray-200'}`}>コード提出</button>
        <button onClick={() => { setActiveTab('submissions'); setSelectedSubId(null); setDetailTab('results'); }} className={`px-4 py-2 rounded-t-lg font-bold border-t border-l border-r flex items-center gap-1 ${activeTab === 'submissions' ? 'bg-white text-blue-600 border-gray-200 -mb-px' : 'bg-gray-100 text-gray-500 border-transparent hover:bg-gray-200'}`}><LayoutList size={18} /> 実行結果</button>
        <button onClick={() => setActiveTab('stats')} className={`px-4 py-2 rounded-t-lg font-bold border-t border-l border-r flex items-center gap-1 ${activeTab === 'stats' ? 'bg-white text-blue-600 border-gray-200 -mb-px' : 'bg-gray-100 text-gray-500 border-transparent hover:bg-gray-200'}`}><BarChart2 size={18} /> 統計 {selectedForStats.size > 0 && <span className="ml-auto bg-blue-100 text-blue-700 py-0.5 px-2 rounded-full text-xs">{selectedForStats.size}</span>}</button>
        <button onClick={() => setActiveTab('tuning')} className={`px-4 py-2 rounded-t-lg font-bold border-t border-l border-r flex items-center gap-1 ${activeTab === 'tuning' ? 'bg-white text-purple-600 border-gray-200 -mb-px' : 'bg-gray-100 text-gray-500 border-transparent hover:bg-gray-200'}`}>
          <Sliders size={18} /> 定数チューニング
          {tuningStatus === 'running' && <span className="ml-1 w-2 h-2 bg-green-500 rounded-full animate-pulse inline-block" />}
          {tuningStatus === 'paused' && <span className="ml-1 w-2 h-2 bg-yellow-500 rounded-full inline-block" />}
        </button>
      </div>

      {/* 画面を左右に分割するメインエリア */}
      <main className="flex-1 min-h-0 flex flex-row overflow-hidden w-full">

        {/* 左側エリア（提出結果・エディタ）— 独立スクロール */}
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden p-4">
          {activeTab === 'submit' && (
            <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden">
            <div className={visData ? '' : 'max-w-7xl mx-auto w-full'}>
            <>
            <div className="bg-white border border-gray-300 rounded-lg shadow-sm flex flex-col h-[calc(100vh-140px)] min-h-[500px]">
              {config?.archived && (
                <div className="px-4 py-3 bg-amber-50 border-b border-amber-200 text-sm font-bold text-amber-800">
                  このコンテストはアーカイブ済みです。提出やIO閲覧はできず、提出一覧と統計のみ閲覧できます。
                </div>
              )}
              <div className="p-3 border-b border-gray-200 flex gap-4 items-center bg-gray-50 rounded-t-lg overflow-x-auto">
                <select value={language} onChange={(e) => {
                  const lang = e.target.value;
                  setLanguage(lang);
                  const isTemplate = Object.values(DEFAULT_CODE).some(t => code.trim() === t.trim());
                  if (isTemplate) setCode(DEFAULT_CODE[lang] ?? '');
                }} className="border rounded p-1.5 text-sm font-bold bg-white">
                  <option value="cpp">C++ (GCC)</option>
                  <option value="rust">Rust</option>
                  <option value="python">Python 3</option>
                </select>
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <span className="text-sm font-bold">実行数:</span>
                  <input type="number" min="1" value={testCases} onChange={(e) => setTestCases(Number(e.target.value))} className="border rounded p-1.5 w-16 text-sm bg-white" />
                </div>
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <span className="text-sm font-bold text-gray-400">|</span>
                  <span className="text-sm font-bold">制限(秒):</span>
                  <input type="number" step="0.5" min="0.1" value={timeLimit} onChange={(e) => setTimeLimit(Number(e.target.value))} className="border rounded p-1.5 w-16 text-sm bg-white" />
                </div>
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <span className="text-sm font-bold">メモリ(MB):</span>
                  <input type="number" step="128" min="128" value={memoryLimit} onChange={(e) => setMemoryLimit(Number(e.target.value))} className="border rounded p-1.5 w-20 text-sm bg-white" />
                </div>
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <span className="text-sm font-bold">並列数:</span>
                  <input
                    type="number"
                    min="1"
                    value={parallelism}
                    onChange={(e) => setParallelism(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                    className="border rounded p-1.5 w-16 text-sm bg-white"
                  />
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <CopyButton text={code} className="py-1.5 px-3 text-sm" />
                  <button
                    onClick={async () => {
                      try {
                        let text = '';
                        try { text = await readText() || ''; } catch {}
                        if (!text) text = clipboardCacheRef.current;
                        if (text && editorRef.current) {
                          editorRef.current.setValue(text);
                          editorRef.current.focus();
                        }
                      } catch (err) { console.error('貼り付け失敗:', err); }
                    }}
                    className="flex items-center gap-1 px-3 py-1.5 rounded text-sm font-bold bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors whitespace-nowrap"
                    title="クリップボードから貼り付け (Ctrl+V)"
                  >
                    <Copy size={13} /> 貼り付け
                  </button>
                  <button disabled={isProcessing || isSubmitting || !!config?.archived} onClick={handleSubmit} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold py-1.5 px-6 rounded shadow flex items-center gap-2 transition-all whitespace-nowrap">
                    {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} fill="currentColor" />}
                    {currentRunningSubmissionId || currentQueuedCount > 0 ? '提出を追加' : 'コンパイルして実行'}
                  </button>
                  {currentCancellableSubmissionId && !config?.archived && (
                    <button onClick={() => cancelSubmission(currentCancellableSubmissionId)} className="bg-red-500 hover:bg-red-600 text-white font-bold py-1.5 px-4 rounded shadow flex items-center gap-2 transition-all whitespace-nowrap">
                      ✕ キャンセル
                    </button>
                  )}
                </div>
              </div>
              <div className="px-4 py-3 border-b border-gray-200 bg-white space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-bold text-gray-700">実行モード:</span>
                  <button onClick={() => setSubmitMode('regular')} className={`px-3 py-1.5 rounded-lg text-sm font-bold border ${submitMode === 'regular' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-300'}`}>通常</button>
                  <button onClick={() => setSubmitMode('favorites')} className={`px-3 py-1.5 rounded-lg text-sm font-bold border ${submitMode === 'favorites' ? 'bg-yellow-500 text-white border-yellow-500' : 'bg-white text-gray-600 border-gray-300 hover:border-yellow-300'}`}>お気に入り実行</button>
                  <button onClick={() => setSubmitMode('filtered')} className={`px-3 py-1.5 rounded-lg text-sm font-bold border ${submitMode === 'filtered' ? 'bg-amber-600 text-white border-amber-600' : 'bg-white text-gray-600 border-gray-300 hover:border-amber-300'}`}>変数絞り込み</button>
                </div>
                {isCustomSubmitMode && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-900">
                    このモードの提出は一部ケースのみでの参考実行です。正規のスコアと一致しない可能性があります。
                  </div>
                )}
                {submitMode === 'favorites' && (
                  <p className="text-xs text-gray-600">
                    お気に入り登録済みケースから昇順で `min(実行数, お気に入り数)` 件だけ実行します。
                  </p>
                )}
                {submitMode === 'filtered' && (
                  <div className="space-y-2">
                    <p className="text-xs text-gray-600">
                      条件に合うケースが `実行数` に達するまで入力生成を広げて探索します。30秒を超えたら、その時点で見つかった件数だけ実行します。
                    </p>
                    {submitActiveVars.length === 0 ? (
                      <p className="text-xs text-red-600 font-bold">入力1行目の変数設定がないため、変数絞り込みは使えません。</p>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        {submitActiveVars.map(v => (
                          <div key={v} className="space-y-1">
                            <label className="text-xs font-bold text-gray-600">{v}</label>
                            <div className="flex items-center gap-2">
                              <input
                                type="number"
                                placeholder="Min"
                                className="w-full border p-1.5 text-sm rounded"
                                value={submitVarFilters[v]?.min ?? ''}
                                onChange={e => setSubmitVarFilters(prev => ({ ...prev, [v]: { ...prev[v], min: e.target.value ? Number(e.target.value) : '' } }))}
                              />
                              <span className="text-gray-400">-</span>
                              <input
                                type="number"
                                placeholder="Max"
                                className="w-full border p-1.5 text-sm rounded"
                                value={submitVarFilters[v]?.max ?? ''}
                                onChange={e => setSubmitVarFilters(prev => ({ ...prev, [v]: { ...prev[v], max: e.target.value ? Number(e.target.value) : '' } }))}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              {parallelism > logicalProcessorCount && (
                <div className="px-3 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-700 font-bold">
                  並列数が論理プロセッサ数 ({logicalProcessorCount}) を超えています。処理が遅くなることがあります。
                </div>
              )}
              <div className="flex-1 relative">
                <Editor height="100%" language={language === 'python' ? 'python' : language === 'rust' ? 'rust' : 'cpp'} theme="vs-light" value={code} onChange={(v) => setCode(v || '')}
                  onMount={(editor, monaco) => {
                    editorRef.current = editor;
                    // フォーカス時にクリップボードをキャッシュ（Ctrl+Aによる汚染対策）
                    editor.onDidFocusEditorWidget(async () => {
                      try {
                        const t = await readText();
                        if (t) clipboardCacheRef.current = t;
                      } catch {}
                    });
                    // Ctrl+A をオーバーライド: WebKit にクリップボードを触らせない
                    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyA, () => {
                      const model = editor.getModel();
                      if (model) editor.setSelection(model.getFullModelRange());
                    });
                    // Ctrl+V / Cmd+V を Tauri ネイティブクリップボード経由に上書き
                    editor.onKeyDown(async (e: any) => {
                      if ((e.ctrlKey || e.metaKey) && e.keyCode === monaco.KeyCode.KeyV && !e.shiftKey) {
                        e.preventDefault();
                        e.stopPropagation();
                        try {
                          let text = '';
                          try { text = await readText() || ''; } catch {}
                          if (!text) text = clipboardCacheRef.current; // Ctrl+A後の汚染フォールバック
                          if (text) {
                            const selections = editor.getSelections() ?? [];
                            const model = editor.getModel();
                            const edits = selections.length > 0
                              ? selections.map((sel: any) => ({ range: sel, text, forceMoveMarkers: true }))
                              : model ? [{ range: model.getFullModelRange(), text, forceMoveMarkers: true }] : [];
                            if (edits.length > 0) editor.executeEdits('clipboard-paste', edits);
                          }
                        } catch (err) { console.error('Ctrl+V 貼り付け失敗:', err); }
                      }
                    });
                  }}
                  options={{ fontSize: 14, minimap: { enabled: false } }} />
                {isProcessing && <div className="absolute inset-0 bg-white/50 backdrop-blur-sm z-10 flex items-center justify-center"><Loader2 size={48} className="animate-spin text-blue-600" /></div>}
              </div>
            </div>
            {submitError && (
              <div className="mt-3 bg-white border border-red-300 rounded-lg shadow-sm overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2 bg-red-50 border-b border-red-200">
                  <span className="text-sm font-bold text-red-700 flex items-center gap-2">
                    <AlertCircle size={16} /> コンパイルエラー詳細
                  </span>
                  <div className="flex items-center gap-2">
                    <CopyButton text={submitError} />
                    <button onClick={() => setSubmitError(null)} className="text-red-400 hover:text-red-600 text-xs font-bold px-2 py-1">✕ 閉じる</button>
                  </div>
                </div>
                <pre className="text-xs font-mono text-gray-800 p-4 max-h-64 overflow-auto whitespace-pre-wrap break-all">{submitError}</pre>
              </div>
            )}
          </>
          </div>
          </div>
          )}

          {activeTab === 'submissions' && (
            <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden">
            <div className={visData ? '' : 'max-w-7xl mx-auto w-full'}>
            <div className="bg-white border border-gray-300 rounded-lg shadow-sm p-6 min-h-[500px]">
              {!selectedSubId && (
                <>
                  <h2 className="text-2xl font-bold flex items-center gap-2 mb-4 border-b pb-4"><LayoutList className="text-blue-500" /> 提出一覧</h2>
                  {sortedSubmissions.length === 0 ? (
                    <p className="text-gray-500 text-center py-10">まだ提出がありません。</p>
                  ) : (() => {
                    // ケース数の種類を収集
                    const caseCountSet = new Set(sortedSubmissions.map((s: any) => s.testCases?.length ?? 0));
                    const caseCountOptions = [...caseCountSet].sort((a, b) => a - b);
                    let filtered = caseCountFilter.size === 0
                      ? sortedSubmissions
                      : sortedSubmissions.filter((s: any) => caseCountFilter.has(s.testCases?.length ?? 0));
                    if (showSubmissionFavoritesOnly) {
                      filtered = filtered.filter((s: any) => submissionFavorites.has(s.id));
                    }
                    return (
                    <>
                      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                        <button
                          onClick={() => { setShowSubmissionFavoritesOnly(v => !v); setSubPage(1); }}
                          className={`px-3 py-1.5 rounded-lg text-sm font-bold border flex items-center gap-2 transition-colors ${showSubmissionFavoritesOnly ? 'bg-yellow-100 text-yellow-800 border-yellow-300' : 'bg-white text-gray-600 border-gray-300 hover:border-yellow-300 hover:text-yellow-700'}`}
                        >
                          <Star size={16} fill={showSubmissionFavoritesOnly ? 'currentColor' : 'none'} />
                          {showSubmissionFavoritesOnly ? '提出お気に入りのみ表示中' : '提出お気に入りのみ表示'}
                        </button>
                      </div>
                      {caseCountOptions.length > 1 && (
                        <div className="flex items-center gap-2 mb-3 flex-wrap">
                          <span className="text-xs font-bold text-gray-500">ケース数:</span>
                          {caseCountOptions.map(n => {
                            const active = caseCountFilter.has(n);
                            return (
                              <button key={n} onClick={() => {
                                const next = new Set(caseCountFilter);
                                active ? next.delete(n) : next.add(n);
                                setCaseCountFilter(next);
                                setSubPage(1);
                              }} className={`px-2.5 py-0.5 rounded-full text-xs font-bold border transition-colors ${active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'}`}>
                                {n}件
                              </button>
                            );
                          })}
                          {caseCountFilter.size > 0 && (
                            <button onClick={() => { setCaseCountFilter(new Set()); setSubPage(1); }} className="text-xs text-gray-400 hover:text-red-500 transition-colors">解除</button>
                          )}
                        </div>
                      )}
                      <Pagination page={subPage} total={filtered.length} pageSize={subPageSize}
                        onPage={setSubPage} onPageSize={setSubPageSize} />
                      <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse whitespace-nowrap">
                        <thead>
                          <tr className="bg-gray-100 border-b-2 border-gray-300 text-sm select-none">
                            <th className="p-3 font-bold text-center w-12">★</th>
                            <th className="p-3 font-bold w-40 cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => handleSubmissionSort('timestamp')}>提出日時 {submissionSort.key === 'timestamp' && (submissionSort.order === 'asc' ? '↑' : '↓')}</th>
                            <th className="p-3 font-bold">コード名</th>
                            <th className="p-3 font-bold text-right cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => handleSubmissionSort('totalScore')}>{scoreColumnLabel} {submissionSort.key === 'totalScore' && (submissionSort.order === 'asc' ? '↑' : '↓')}</th>
                            <th className="p-3 font-bold text-right cursor-pointer hover:bg-gray-200 transition-colors text-blue-700" onClick={() => handleSubmissionSort('totalRelScore')}>相対スコア {submissionSort.key === 'totalRelScore' && (submissionSort.order === 'asc' ? '↑' : '↓')}</th>
                            <th className="p-3 font-bold text-right cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => handleSubmissionSort('uniqueCaseCount')}>ユニーク {submissionSort.key === 'uniqueCaseCount' && (submissionSort.order === 'asc' ? '↑' : '↓')}</th>
                            <th className="p-3 font-bold text-right cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => handleSubmissionSort('codeLength')}>コード長 {submissionSort.key === 'codeLength' && (submissionSort.order === 'asc' ? '↑' : '↓')}</th>
                            <th className="p-3 font-bold text-right cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => handleSubmissionSort('execTime')}>Max Time {submissionSort.key === 'execTime' && (submissionSort.order === 'asc' ? '↑' : '↓')}</th>
                            <th className="p-3 font-bold text-center w-28">結果</th>
                            <th className="p-3 font-bold text-center w-24">操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filtered.slice((subPage - 1) * subPageSize, subPage * subPageSize).map((sub: any) => (
                            <tr key={sub.id} className="border-b hover:bg-gray-50 transition-colors">
                              <td className="p-3 text-center">
                                <button
                                  onClick={() => toggleSubmissionFavorite(sub.id)}
                                  className={`inline-flex items-center justify-center transition-colors ${submissionFavorites.has(sub.id) ? 'text-yellow-500' : 'text-gray-300 hover:text-yellow-400'}`}
                                  title={submissionFavorites.has(sub.id) ? '提出お気に入り解除' : '提出お気に入り'}
                                >
                                  <Star size={18} fill={submissionFavorites.has(sub.id) ? 'currentColor' : 'none'} />
                                </button>
                              </td>
                              <td className="p-3 text-sm text-gray-600">{sub.time}</td>
                              <td className="p-3">
                                <div className="flex items-center gap-2 group flex-wrap">
                                  <input type="text" value={sub.name} onChange={(e) => updateSubName(sub.id, e.target.value)} className="border-b border-transparent hover:border-gray-300 focus:border-blue-500 focus:outline-none bg-transparent px-1 w-full max-w-[150px]" />
                                  <Edit2 size={12} className="text-gray-400 opacity-0 group-hover:opacity-100" />
                                  {sub.executionTag && <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">{sub.executionTag}</span>}
                                </div>
                              </td>
                              <td className="p-3 font-mono text-right font-bold text-blue-600">{formatSubmissionScore(sub)}</td>
                              <td className="p-3 font-mono text-right font-bold text-blue-600">{sub.totalRelScore.toLocaleString()}</td>
                              <td className="p-3 font-mono text-right font-bold text-indigo-600">{sub.uniqueCaseCount.toLocaleString()}</td>
                              <td className="p-3 font-mono text-right text-sm">{sub.codeLength} B</td>
                              <td className="p-3 font-mono text-right text-sm">{sub.execTime.toFixed(3)} s</td>
                              <td className="p-3 text-center">{getStatusBadge(sub.status)}</td>
                              <td className="p-3 flex items-center justify-center gap-2">
                                <button onClick={() => openSubmissionDetail(sub.id, 'submissions')} className="text-blue-500 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded text-sm font-bold flex items-center">詳細</button>
                                {(sub.status === 'WJ' || sub.status === 'Compiling...' || String(sub.status).startsWith('Running')) && (
                                  <button onClick={() => cancelSubmission(sub.id)} className="text-orange-500 hover:text-orange-700 p-1 rounded hover:bg-orange-50 transition-colors" title="キャンセル">
                                    <StopCircle size={16} />
                                  </button>
                                )}
                                <button onClick={(e) => handleDeleteSubmission(e, sub.id)} className="text-gray-400 hover:text-red-500 p-1 rounded hover:bg-red-50 transition-colors" title="削除"><Trash2 size={16} /></button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      </div>
                      <Pagination page={subPage} total={filtered.length} pageSize={subPageSize}
                        onPage={setSubPage} onPageSize={setSubPageSize} />
                    </>
                    );
                  })()}
                </>
              )}

              {selectedSubId && selectedSub && (
                <div className="animate-in fade-in slide-in-from-right-4 duration-200">
                  <div className="sticky top-0 z-20 -mx-6 mb-4 border-b border-gray-200 bg-white/95 px-6 py-3">
                    <button
                      onClick={closeSubmissionDetail}
                      className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-bold text-blue-800 shadow-sm transition-colors hover:bg-blue-100"
                    >
                      <ArrowLeft size={15} />
                      {detailReturnTab === 'stats' ? '統計へ戻る' : '一覧へ戻る'}
                    </button>
                  </div>
                  <div className="flex flex-wrap justify-between items-center mb-6 border-b pb-4 gap-4">
                    <div>
                      <div className="flex items-center gap-3 flex-wrap">
                        <h2 className="text-2xl font-bold flex items-center gap-2"><Trophy className="text-yellow-500" /> {selectedSub.name} の結果</h2>
                        {selectedSub.executionTag && (
                          <span className="px-3 py-1 rounded-full bg-amber-100 text-amber-900 border border-amber-300 text-sm font-bold">
                            {selectedSub.executionTag}
                          </span>
                        )}
                        {(selectedSub.status === 'WJ' || selectedSub.status === 'Compiling...' || String(selectedSub.status).startsWith('Running')) && (
                          <button onClick={() => cancelSubmission(selectedSub.id)} className="px-3 py-1.5 rounded-lg bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 text-sm font-bold flex items-center gap-2">
                            <StopCircle size={15} /> この提出をキャンセル
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="text-right flex flex-wrap items-end gap-6">
                      <div>
                        <p className="text-sm text-gray-500 font-bold mb-1">Status</p>
                        {getStatusBadge(selectedSub.status)}
                      </div>
                      <div>
                        <p className="text-sm text-gray-500 font-bold mb-1 flex items-center gap-1 justify-end"><Clock size={14} /> Max Time</p>
                        <p className="text-xl font-mono font-bold">{selectedSub.execTime.toFixed(3)}s</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-500 font-bold mb-1">{scoreColumnLabel}</p>
                        <p className="text-3xl font-mono font-bold text-blue-600 leading-none">{formatSubmissionScore(selectedSub)}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-500 font-bold mb-1">ユニークケース数</p>
                        <p className="text-2xl font-mono font-bold text-indigo-600 leading-none">
                          {((selectedSub.testCases || []).reduce((acc, tc) => acc + (calcRelativeScore(tc, bestScores[tc.id]) === maxRelativeScore ? 1 : 0), 0)).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-2 mb-4">
                    <button onClick={() => setDetailTab('results')} className={`px-4 py-2 rounded-lg font-bold flex items-center gap-2 transition-colors ${detailTab === 'results' ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                      <LayoutList size={16} /> テストケース
                    </button>
                    <button onClick={() => setDetailTab('code')} className={`px-4 py-2 rounded-lg font-bold flex items-center gap-2 transition-colors ${detailTab === 'code' ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                      <FileCode2 size={16} /> 提出コード
                    </button>
                  </div>

                  {detailTab === 'results' ? (
                    <div>
                      {relScoreTooltip && (
                        <div
                          className="fixed z-50 pointer-events-none"
                          style={{ left: relScoreTooltip.x + 12, top: relScoreTooltip.y - 10 }}
                        >
                          <div className="bg-gray-900 text-white text-xs rounded-lg px-3 py-2 shadow-lg max-w-72">
                            <p className="font-bold text-blue-300 mb-1">case {String(relScoreTooltip.caseId).padStart(4, '0')} の最善提出</p>
                            <p className="text-gray-300 mb-1">best score: {relScoreTooltip.bestScore.toLocaleString()}</p>
                            {relScoreTooltip.winners.length === 0 ? (
                              <p className="text-gray-400">該当提出なし</p>
                            ) : (
                              <div className="space-y-0.5">
                                {relScoreTooltip.winners.map(w => (
                                  <p key={w.id} className="truncate">
                                    <span className="font-bold text-white">{w.name}</span>
                                    <span className="text-gray-400"> ({w.score.toLocaleString()})</span>
                                  </p>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                      {(() => {
                        const sortedCases = [...(selectedSub.testCases || [])]
                          .filter(r => !showFavoritesOnly || favorites.has(r.id))
                          .sort((a, b) => {
                          let valA = a[testCaseSort.key as keyof typeof a];
                          let valB = b[testCaseSort.key as keyof typeof b];

                          if (testCaseSort.key === 'relScore') {
                            valA = calcRelativeScore(a, bestScores[a.id]);
                            valB = calcRelativeScore(b, bestScores[b.id]);
                          }

                          if (valA < valB) return testCaseSort.order === 'asc' ? -1 : 1;
                          if (valA > valB) return testCaseSort.order === 'asc' ? 1 : -1;
                          return 0;
                        });
                        const pagedCases = sortedCases.slice((tcPage - 1) * tcPageSize, tcPage * tcPageSize);

                        return (
                          <>
                            <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
                              <div className="text-xs text-gray-500 font-bold">
                                左端の星でケースをお気に入り登録できます。
                              </div>
                              <button
                                onClick={() => { setShowFavoritesOnly(v => !v); setTcPage(1); }}
                                className={`px-3 py-1.5 rounded-lg text-sm font-bold border flex items-center gap-2 transition-colors ${showFavoritesOnly ? 'bg-yellow-100 text-yellow-800 border-yellow-300' : 'bg-white text-gray-600 border-gray-300 hover:border-yellow-300 hover:text-yellow-700'}`}
                              >
                                <Star size={16} fill={showFavoritesOnly ? 'currentColor' : 'none'} />
                                {showFavoritesOnly ? 'お気に入りのみ表示中' : 'お気に入りのみ表示'}
                              </button>
                            </div>
                            <Pagination page={tcPage} total={sortedCases.length} pageSize={tcPageSize}
                              onPage={setTcPage} onPageSize={setTcPageSize} />
                          <div className="overflow-x-auto">
                          <table className="w-full text-left border-collapse whitespace-nowrap">
                            <thead>
                              <tr className="bg-gray-100 border-b-2 border-gray-300">
                                <th className="p-3 font-bold w-8 text-center">
                                  <div className="flex flex-col items-center gap-1">
                                    <Star size={18} className={showFavoritesOnly ? 'text-yellow-500' : 'text-gray-400'} fill={showFavoritesOnly ? 'currentColor' : 'none'} />
                                    <span className="text-[10px] text-gray-500">お気に入り</span>
                                  </div>
                                </th>
                                <th className="p-3 font-bold w-20 text-center cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => handleTestCaseSort('id')}>Case {testCaseSort.key === 'id' && (testCaseSort.order === 'asc' ? '↑' : '↓')}</th>
                                <th className="p-3 font-bold w-24 text-center cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => handleTestCaseSort('status')}>Status {testCaseSort.key === 'status' && (testCaseSort.order === 'asc' ? '↑' : '↓')}</th>
                                <th className="p-3 font-bold w-24 text-right cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => handleTestCaseSort('time')}>Time {testCaseSort.key === 'time' && (testCaseSort.order === 'asc' ? '↑' : '↓')}</th>
                                <th className="p-3 font-bold text-right cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => handleTestCaseSort('score')}>Score {testCaseSort.key === 'score' && (testCaseSort.order === 'asc' ? '↑' : '↓')}</th>
                                <th className="p-3 font-bold text-right cursor-pointer hover:bg-gray-200 transition-colors text-blue-700" onClick={() => handleTestCaseSort('relScore')}>相対スコア {testCaseSort.key === 'relScore' && (testCaseSort.order === 'asc' ? '↑' : '↓')}</th>
                                <th className="p-3 font-bold w-24 text-center">Vis</th>
                                <th className="p-3 font-bold w-20 text-center">入出力</th>
                                <th className="p-3 font-bold">Details</th>
                              </tr>
                            </thead>
                            <tbody>
                              {pagedCases.map((r) => {
                                const relScore = calcRelativeScore(r, bestScores[r.id]);
                                const bestForCase = getBestSubmissionsForCase(r.id);
                                return (
                                  <React.Fragment key={r.id}>
                                    <tr className={`border-b hover:bg-gray-50 ${visData && r.id === Number(visData.input.match(/Case: (\d+)/)?.[1] || r.id) ? 'bg-blue-50' : ''}`}>
                                      <td className="p-3 text-center">
                                        <button onClick={() => toggleFavorite(r.id)}
                                          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-xs font-bold transition-colors ${favorites.has(r.id) ? 'bg-yellow-100 text-yellow-800 border-yellow-300' : 'bg-white text-gray-500 border-gray-200 hover:border-yellow-300 hover:text-yellow-700'}`}
                                          title={favorites.has(r.id) ? 'お気に入り解除' : 'お気に入りに追加'}>
                                          <Star size={18} fill={favorites.has(r.id) ? 'currentColor' : 'none'} />
                                          <span>{favorites.has(r.id) ? '登録済み' : '登録'}</span>
                                        </button>
                                      </td>
                                      <td className="p-3 font-mono text-center text-gray-500">{String(r.id).padStart(4, '0')}</td>
                                      <td className="p-3 text-center">{getStatusBadge(r.status)}</td>
                                      <td className="p-3 font-mono text-right text-gray-600">{r.time.toFixed(3)}s</td>
                                      <td className="p-3 font-mono text-right font-bold">{isAcceptedResult(r) || r.score > 0 ? r.score.toLocaleString() : '-'}</td>
                                      <td className="p-3 text-right">
                                        <span
                                          className="inline-block font-mono font-bold text-blue-600 border-b border-dotted border-blue-300 cursor-help"
                                          onMouseEnter={(e) => {
                                            const rect = e.currentTarget.getBoundingClientRect();
                                            setRelScoreTooltip({
                                              caseId: r.id,
                                              x: rect.right,
                                              y: rect.top + rect.height / 2,
                                              bestScore: bestForCase.bestScore,
                                              winners: bestForCase.winners,
                                            });
                                          }}
                                          onMouseLeave={() => setRelScoreTooltip(prev => prev?.caseId === r.id ? null : prev)}
                                        >
                                          {relScore.toLocaleString()}
                                        </span>
                                      </td>
                                      <td className="p-3 text-center">
                                        <button disabled={!!config?.archived} onClick={() => openVisualizer(r.id, selectedSub.id)} className="text-gray-600 hover:text-blue-600 p-1 hover:bg-blue-50 rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent" title={config?.archived ? 'アーカイブ済みのため利用できません' : 'アプリ内でビジュアライザを再生'}><Play size={18} /></button>
                                      </td>
                                      <td className="p-3 text-center">
                                        <button
                                          disabled={!!config?.archived}
                                          onClick={() => toggleCaseIO(r.id, selectedSub.id)}
                                          className={`px-2 py-1 rounded text-xs font-bold transition-colors disabled:opacity-40 ${expandedCaseIO[r.id] !== undefined ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                                          title={config?.archived ? 'アーカイブ済みのため利用できません' : '入出力を表示'}
                                        >
                                          {expandedCaseIO[r.id] === 'loading' ? '...' : 'IO'}
                                        </button>
                                      </td>
                                      <td className="p-3 text-sm text-gray-700">
                                        <input
                                          type="text"
                                          className="w-full bg-transparent border-b border-transparent hover:border-gray-300 focus:border-blue-500 focus:bg-white focus:outline-none transition-all p-1"
                                          placeholder="例: Nが最大、すべて0 ..."
                                          value={memos[r.id.toString()] || ''}
                                          onChange={(e) => setMemos({ ...memos, [r.id.toString()]: e.target.value })}
                                          onBlur={(e) => handleMemoBlur(r.id, e.target.value)}
                                        />
                                      </td>
                                    </tr>
                                    {expandedCaseIO[r.id] && expandedCaseIO[r.id] !== 'loading' && (
                                      <tr className="bg-gray-50 border-b">
                                        <td colSpan={9} className="px-4 py-3">
                                          {(() => {
                                            const io = expandedCaseIO[r.id] as { input: string; output: string; stderr: string };
                                            const hasErr = !!io.stderr.trim();
                                            return (
                                              <div className={`grid gap-4 ${hasErr ? 'grid-cols-3' : 'grid-cols-2'}`}>
                                                <div>
                                                  <div className="flex items-center justify-between mb-1">
                                                    <p className="text-xs font-bold text-gray-500 uppercase tracking-wide">Input</p>
                                                    <CopyButton text={io.input} />
                                                  </div>
                                                  <pre className="text-xs font-mono bg-white border border-gray-200 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-gray-700">{io.input}</pre>
                                                </div>
                                                <div>
                                                  <div className="flex items-center justify-between mb-1">
                                                    <p className="text-xs font-bold text-gray-500 uppercase tracking-wide">Output</p>
                                                    <CopyButton text={io.output} />
                                                  </div>
                                                  <pre className="text-xs font-mono bg-white border border-gray-200 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-gray-700">{io.output}</pre>
                                                </div>
                                                {hasErr && (
                                                  <div>
                                                    <div className="flex items-center justify-between mb-1">
                                                      <p className="text-xs font-bold text-red-500 uppercase tracking-wide">Stderr</p>
                                                      <CopyButton text={io.stderr} />
                                                    </div>
                                                    <pre className="text-xs font-mono bg-red-50 border border-red-200 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-red-700">{io.stderr}</pre>
                                                  </div>
                                                )}
                                              </div>
                                            );
                                          })()}
                                        </td>
                                      </tr>
                                    )}
                                  </React.Fragment>
                                );
                              })}
                            </tbody>
                          </table>
                          </div>
                            <Pagination page={tcPage} total={sortedCases.length} pageSize={tcPageSize}
                              onPage={setTcPage} onPageSize={setTcPageSize} />
                          </>
                        );
                      })()}
                    </div>
                  ) : selectedSub.code ? (
                    <div className="space-y-3">
                      {selectedSub.compileError && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-sm font-bold text-red-700">コンパイルエラー</p>
                            <CopyButton text={selectedSub.compileError} />
                          </div>
                          <pre className="text-xs font-mono whitespace-pre-wrap break-all text-red-700">{selectedSub.compileError}</pre>
                        </div>
                      )}
                      <div className="h-[500px] border border-gray-300 rounded-lg overflow-hidden relative">
                        <div className="absolute top-2 right-3 z-10">
                          <CopyButton text={selectedSub.code} className="shadow-sm" />
                        </div>
                        <Editor language={selectedSub.language === 'python' ? 'python' : selectedSub.language === 'rust' ? 'rust' : 'cpp'} theme="vs-light" value={selectedSub.code} options={{ readOnly: true, minimap: { enabled: false }, fontSize: 14 }} />
                      </div>
                    </div>
                  ) : (
                    <div className="h-[240px] border border-dashed border-amber-300 rounded-lg bg-amber-50 flex items-center justify-center text-sm font-bold text-amber-800">
                      アーカイブ済みのため提出コードは削除されています。
                    </div>
                  )}
                </div>
              )}
            </div>
            </div>
            </div>
          )}

          {/* ★ ここから追加：統計タブ */}
          {activeTab === 'stats' && (
            <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden p-6 bg-gray-50 flex flex-col gap-6 relative">
              <div className={visData ? '' : 'max-w-7xl mx-auto w-full'}>
              {/* ポイントホバー用フローティングツールチップ */}
              {statsPointTooltip && (
                <div
                  className="fixed z-50 pointer-events-none"
                  style={{ left: statsPointTooltip.px + 12, top: statsPointTooltip.py - 10 }}
                >
                  <ChartPointTooltip score={statsPointTooltip.score} id={statsPointTooltip.id} label={statsPointTooltip.label} />
                </div>
              )}

              <h2 className="text-2xl font-bold flex items-center gap-2 text-gray-800 shrink-0">
                <BarChart2 size={28} className="text-blue-600" /> 統計・分析
              </h2>

              {/* ── 提出選択パネル ── */}
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden shrink-0">
                <div className="p-3 bg-gray-50 border-b flex items-center justify-between">
                  <h3 className="font-bold text-gray-700">比較する提出を選択</h3>
                  {selectedForStats.size > 0 && (
                    <button onClick={() => setSelectedForStats(new Set())} className="text-xs text-gray-400 hover:text-red-500 transition-colors">すべて解除</button>
                  )}
                </div>
                {submissions.length === 0 ? (
                  <p className="text-sm text-gray-400 p-4">提出がありません</p>
                ) : (
                  <>
                    <table className="w-full text-left text-sm whitespace-nowrap">
                      <thead>
                        <tr className="bg-gray-50 border-b text-gray-500 text-xs">
                          <th className="py-2 px-3 font-normal w-8"></th>
                          <th className="py-2 px-3 font-normal w-10 text-center">★</th>
                          <th className="py-2 px-3 font-normal w-36 cursor-pointer" onClick={() => handleStatsSubmissionSort('timestamp')}>提出日時 {statsSubmissionSort.key === 'timestamp' && (statsSubmissionSort.order === 'asc' ? '↑' : '↓')}</th>
                          <th className="py-2 px-3 font-normal cursor-pointer" onClick={() => handleStatsSubmissionSort('name')}>コード名 {statsSubmissionSort.key === 'name' && (statsSubmissionSort.order === 'asc' ? '↑' : '↓')}</th>
                          <th className="py-2 px-3 font-normal text-right cursor-pointer" onClick={() => handleStatsSubmissionSort('totalScore')}>{scoreColumnLabel} {statsSubmissionSort.key === 'totalScore' && (statsSubmissionSort.order === 'asc' ? '↑' : '↓')}</th>
                          <th className="py-2 px-3 font-normal text-right cursor-pointer" onClick={() => handleStatsSubmissionSort('totalRelScore')}>相対スコア {statsSubmissionSort.key === 'totalRelScore' && (statsSubmissionSort.order === 'asc' ? '↑' : '↓')}</th>
                          <th className="py-2 px-3 font-normal text-right cursor-pointer" onClick={() => handleStatsSubmissionSort('uniqueCaseCount')}>ユニーク {statsSubmissionSort.key === 'uniqueCaseCount' && (statsSubmissionSort.order === 'asc' ? '↑' : '↓')}</th>
                          <th className="py-2 px-3 font-normal text-center cursor-pointer" onClick={() => handleStatsSubmissionSort('status')}>結果 {statsSubmissionSort.key === 'status' && (statsSubmissionSort.order === 'asc' ? '↑' : '↓')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {statsSortedSubmissions
                          .filter((sub: any) => !showSubmissionFavoritesOnly || submissionFavorites.has(sub.id))
                          .slice((statsSubPage - 1) * statsSubPageSize, statsSubPage * statsSubPageSize)
                          .map((sub: any) => {
                          const checked = selectedForStats.has(sub.id);
                          const colorIdx = Array.from(selectedForStats).indexOf(sub.id);
                          const color = checked ? CHART_COLORS[colorIdx % CHART_COLORS.length] : undefined;
                          return (
                            <tr
                              key={sub.id}
                              className={`border-b last:border-0 cursor-pointer transition-colors ${checked ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-gray-50'}`}
                              onClick={() => {
                                const next = new Set(selectedForStats);
                                checked ? next.delete(sub.id) : next.add(sub.id);
                                setSelectedForStats(next);
                              }}
                            >
                              <td className="py-2 px-3">
                                <div className="w-3 h-3 rounded-full border-2 transition-all" style={checked ? { background: color, borderColor: color } : { borderColor: '#d1d5db' }} />
                              </td>
                              <td className="py-2 px-3 text-center">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleSubmissionFavorite(sub.id);
                                  }}
                                  className={`inline-flex items-center justify-center transition-colors ${submissionFavorites.has(sub.id) ? 'text-yellow-500' : 'text-gray-300 hover:text-yellow-400'}`}
                                  title={submissionFavorites.has(sub.id) ? '提出お気に入り解除' : '提出お気に入り'}
                                >
                                  <Star size={16} fill={submissionFavorites.has(sub.id) ? 'currentColor' : 'none'} />
                                </button>
                              </td>
                              <td className="py-2 px-3 text-gray-500">{sub.time}</td>
                              <td className="py-2 px-3 font-bold">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openSubmissionDetail(sub.id, 'stats');
                                  }}
                                  className="hover:underline"
                                  style={checked ? { color } : { color: '#374151' }}
                                >
                                  {sub.name}
                                </button>
                              </td>
                              <td className="py-2 px-3 font-mono text-right text-blue-600 font-bold">{formatSubmissionScore(sub)}</td>
                              <td className="py-2 px-3 font-mono text-right text-blue-600 font-bold">{sub.totalRelScore.toLocaleString()}</td>
                              <td className="py-2 px-3 font-mono text-right text-indigo-600 font-bold">{sub.uniqueCaseCount.toLocaleString()}</td>
                              <td className="py-2 px-3 text-center">{getStatusBadge(sub.status)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <div className="px-3">
                      <div className="py-3 flex items-center justify-between gap-3 flex-wrap">
                        <button
                          onClick={() => { setShowSubmissionFavoritesOnly(v => !v); setStatsSubPage(1); }}
                          className={`px-3 py-1.5 rounded-lg text-sm font-bold border flex items-center gap-2 transition-colors ${showSubmissionFavoritesOnly ? 'bg-yellow-100 text-yellow-800 border-yellow-300' : 'bg-white text-gray-600 border-gray-300 hover:border-yellow-300 hover:text-yellow-700'}`}
                        >
                          <Star size={16} fill={showSubmissionFavoritesOnly ? 'currentColor' : 'none'} />
                          {showSubmissionFavoritesOnly ? '提出お気に入りのみ表示中' : '提出お気に入りのみ表示'}
                        </button>
                      </div>
                      <Pagination
                        page={statsSubPage}
                        total={statsSortedSubmissions.filter((sub: any) => !showSubmissionFavoritesOnly || submissionFavorites.has(sub.id)).length}
                        pageSize={statsSubPageSize}
                        onPage={setStatsSubPage}
                        onPageSize={setStatsSubPageSize}
                      />
                    </div>
                  </>
                )}
              </div>

              {selectedForStats.size === 0 ? (
                <div className="bg-white p-12 text-center rounded-xl border border-gray-200 shadow-sm text-gray-500">
                  上で比較したい提出を選択してください。
                </div>
              ) : (() => {
                const vars = Object.keys(testcaseVars[0] || {});
                const activeVars = vars.filter(v => {
                  const firstVal = testcaseVars[0]?.[v];
                  return Object.values(testcaseVars).some(tc => tc[v] !== firstVal);
                });
                const compareSubmissions = submissions?.filter(s => selectedForStats.has(s.id)) || [];
                // 選択順で色が固定されるようにインデックスを管理
                const subColorMap: Record<string, number> = {};
                Array.from(selectedForStats).forEach((id, i) => { subColorMap[id] = i; });
                const scoreModeLabel = statsScoreMode === 'absolute' ? '絶対スコア' : '相対スコア';

                return (
                  <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                    {/* 左カラム：フィルタ設定 */}
                    <div className="lg:col-span-1 bg-white p-4 rounded-xl shadow-sm border border-gray-200 h-fit space-y-4">
                      <h3 className="font-bold text-gray-700 border-b pb-2">フィルター</h3>
                      <div>
                        <label className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1 block">Y軸</label>
                        <div className="flex gap-1">
                          <button
                            onClick={() => setStatsScoreMode('absolute')}
                            className={`flex-1 py-1.5 text-xs font-bold rounded transition-colors ${statsScoreMode === 'absolute' ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                          >絶対スコア</button>
                          <button
                            onClick={() => setStatsScoreMode('relative')}
                            className={`flex-1 py-1.5 text-xs font-bold rounded transition-colors ${statsScoreMode === 'relative' ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                          >相対スコア</button>
                        </div>
                      </div>
                      <h3 className="font-bold text-gray-700 border-b pb-2 pt-1">seedフィルター</h3>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-gray-500 uppercase tracking-wide block">開始 seed</label>
                        <input type="number" min="0" placeholder="0" className="w-full border p-1.5 text-sm rounded"
                          value={seedRange.min}
                          onChange={e => setSeedRange(r => ({ ...r, min: e.target.value ? Number(e.target.value) : '' }))} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-gray-500 uppercase tracking-wide block">終了 seed</label>
                        <input type="number" min="0" placeholder="上限なし" className="w-full border p-1.5 text-sm rounded"
                          value={seedRange.max}
                          onChange={e => setSeedRange(r => ({ ...r, max: e.target.value ? Number(e.target.value) : '' }))} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-gray-500 uppercase tracking-wide block">お気に入りのみ</label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={showFavoritesOnly}
                            onChange={e => setShowFavoritesOnly(e.target.checked)}
                            className="w-4 h-4 text-yellow-400" />
                          <span className="text-sm text-gray-600 flex items-center gap-1"><Star size={13} className="text-yellow-400" fill="currentColor" /> お気に入りに絞る</span>
                        </label>
                      </div>
                      <h3 className="font-bold text-gray-700 border-b pb-2 pt-1">変数フィルター</h3>
                      {[SCORE_FILTER_KEY, ...activeVars].map(v => (
                        <div key={v} className="space-y-1">
                          <label className="text-sm font-bold text-gray-600">{v === SCORE_FILTER_KEY ? '絶対スコア' : v}</label>
                          <div className="flex items-center gap-2">
                            <input type="number" placeholder="Min" className="w-full border p-1.5 text-sm rounded"
                              value={varFilters[v]?.min ?? ''}
                              onChange={e => setVarFilters({ ...varFilters, [v]: { ...varFilters[v], min: e.target.value ? Number(e.target.value) : '' } })} />
                            <span className="text-gray-400">-</span>
                            <input type="number" placeholder="Max" className="w-full border p-1.5 text-sm rounded"
                              value={varFilters[v]?.max ?? ''}
                              onChange={e => setVarFilters({ ...varFilters, [v]: { ...varFilters[v], max: e.target.value ? Number(e.target.value) : '' } })} />
                          </div>
                        </div>
                      ))}
                      {activeVars.length === 0 && <p className="text-sm text-gray-500">変数がないため、絶対スコアのみ絞り込めます</p>}
                    </div>

                    {/* 右カラム：グラフ + サマリー */}
                    <div className="lg:col-span-3 space-y-6">
                      {(() => {
                        const onHover = (info: HoverInfo) => { setStatsPointTooltip(info); hoveredPointRef.current = { id: info.id }; };
                        const onLeave = () => setStatsPointTooltip(null);
                        const onClickPoint = (id: number, subId: string) => {
                          setCurrentVisSubId(subId);
                          openVisualizer(id, subId);
                        };
                        const hoveredId = statsPointTooltip?.id ?? null;

                        let globalYMin = Infinity, globalYMax = -Infinity;
                        const lineSeries: SeedLineSeries[] = compareSubmissions.map(sub => {
                          const data = (sub.testCases ?? [])
                            .filter((tc: any) => {
                              if (typeof seedRange.min === 'number' && tc.id < seedRange.min) return false;
                              if (typeof seedRange.max === 'number' && tc.id > seedRange.max) return false;
                              if (showFavoritesOnly && !favorites.has(tc.id)) return false;
                              if (!passesAbsoluteScoreFilter(tc, varFilters)) return false;
                              if (!passesVariableFilters(tc, activeVars, testcaseVars, varFilters)) return false;
                              return true;
                            })
                            .map((tc: any) => {
                              const score = getScoreByMode(tc, statsScoreMode);
                              if (score < globalYMin) globalYMin = score;
                              if (score > globalYMax) globalYMax = score;
                              return { id: tc.id, score };
                            });
                          return { subId: sub.id, subName: sub.name, data };
                        });
                        if (globalYMin === Infinity) { globalYMin = 0; globalYMax = 100; }
                        const yPadding = (globalYMax - globalYMin) * 0.05;
                        const yDomain: [number, number] = [globalYMin - yPadding, globalYMax + yPadding];

                        return (
                          <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200" style={deferredSectionStyle}>
                            <div className="flex justify-between items-end mb-3 border-b pb-2 flex-wrap gap-2">
                              <h3 className="font-bold text-lg text-gray-800">
                                {`seed vs ${scoreModeLabel}`}
                                <span className="text-xs bg-blue-100 text-blue-600 px-2 py-1 rounded ml-2">折れ線</span>
                              </h3>
                              <div className="flex gap-4">
                                {compareSubmissions.map((sub) => {
                                  const ci = subColorMap[sub.id] ?? 0;
                                  return (
                                    <span key={sub.id} className="flex items-center gap-1.5 text-sm font-bold" style={{ color: CHART_COLORS[ci % CHART_COLORS.length] }}>
                                      <span className="inline-block w-3 h-3 rounded-sm" style={{ background: CHART_COLORS[ci % CHART_COLORS.length] }} />
                                      {sub.name}
                                    </span>
                                  );
                                })}
                              </div>
                            </div>
                            <p className="text-xs text-gray-400 mb-2">点をクリックするとビジュアライザを開きます</p>
                            <SvgSeedLinePlot
                              series={lineSeries}
                              yDomain={yDomain}
                              subColorMap={subColorMap}
                              onHover={onHover}
                              onLeave={onLeave}
                              onClickPoint={onClickPoint}
                              hoveredId={hoveredId}
                              activeVisId={currentVisId}
                              activeVisSubId={currentVisSubId}
                            />
                          </div>
                        );
                      })()}

                      {activeVars.map(v => {
                        let uniqueValues = new Set<number>();
                        let globalYMin = Infinity, globalYMax = -Infinity;

                        const plotData = compareSubmissions.map(sub => {
                          const subData: ScatterPoint[] = [];
                          const boxMap: Record<number, { score: number; id: number }[]> = {};
                          sub.testCases?.forEach((tc: any) => {
                            const val = testcaseVars[tc.id]?.[v];
                            if (val === undefined) return;
                            if (typeof seedRange.min === 'number' && tc.id < seedRange.min) return;
                            if (typeof seedRange.max === 'number' && tc.id > seedRange.max) return;
                            if (showFavoritesOnly && !favorites.has(tc.id)) return;
                            const fMin = varFilters[v]?.min, fMax = varFilters[v]?.max;
                            if (typeof fMin === 'number' && val < fMin) return;
                            if (typeof fMax === 'number' && val > fMax) return;
                            if (!passesAbsoluteScoreFilter(tc, varFilters)) return;
                            if (!passesVariableFilters(tc, activeVars.filter(name => name !== v), testcaseVars, varFilters)) return;
                            const score = getScoreByMode(tc, statsScoreMode);
                            uniqueValues.add(val);
                            subData.push({ x: val, y: score, id: tc.id });
                            if (!boxMap[val]) boxMap[val] = [];
                            boxMap[val].push({ score, id: tc.id });
                            if (score < globalYMin) globalYMin = score;
                            if (score > globalYMax) globalYMax = score;
                          });
                          const corr = calcCorrelation(subData.map(d => d.x), subData.map(d => d.y));
                          return { subName: sub.name, subId: sub.id, corr, data: subData, boxMap };
                        });

                        const isBoxPlot = uniqueValues.size <= 15;
                        if (globalYMin === Infinity) { globalYMin = 0; globalYMax = 100; }
                        const yPadding = (globalYMax - globalYMin) * 0.05;
                        const yDomain: [number, number] = [globalYMin - yPadding, globalYMax + yPadding];

                        const onHover = (info: HoverInfo) => {
                          setStatsPointTooltip(info);
                          hoveredPointRef.current = { id: info.id };
                        };
                        const onLeave = () => setStatsPointTooltip(null);
                        const onClickPoint = (id: number) => openVisualizer(id, statsPointTooltip?.subId);

                        const hoveredId = statsPointTooltip?.id ?? null;
                        const hoveredScore = statsPointTooltip?.score ?? null;
                        const activeVisScore = currentVisId !== null
                          ? compareSubmissions.flatMap((s: any) => s.testCases ?? []).find((tc: any) => tc.id === currentVisId)?.score ?? null
                          : null;

                        if (isBoxPlot) {
                          const uniqueVals = Array.from(uniqueValues).sort((a, b) => a - b);
                          const chartData = uniqueVals.map(xVal => {
                            const row: Record<string, any> = { xLabel: String(xVal) };
                            compareSubmissions.forEach((sub, si) => {
                              const colorIdx = subColorMap[sub.id] ?? si;
                              const entries = sub.testCases
                                ?.filter((tc: any) => {
                                  const val = testcaseVars[tc.id]?.[v];
                                  if (val !== xVal) return false;
                                  if (typeof seedRange.min === 'number' && tc.id < seedRange.min) return false;
                                  if (typeof seedRange.max === 'number' && tc.id > seedRange.max) return false;
                                  if (showFavoritesOnly && !favorites.has(tc.id)) return false;
                                  const fMin = varFilters[v]?.min, fMax = varFilters[v]?.max;
                                  if (typeof fMin === 'number' && val < fMin) return false;
                                  if (typeof fMax === 'number' && val > fMax) return false;
                                  if (!passesAbsoluteScoreFilter(tc, varFilters)) return false;
                                  if (!passesVariableFilters(tc, activeVars.filter(name => name !== v), testcaseVars, varFilters)) return false;
                                  return true;
                                })
                                .map((tc: any) => ({ score: getScoreByMode(tc, statsScoreMode), id: tc.id })) || [];
                              const stats = calcBoxStatsWithIds(entries);
                              row[`s${colorIdx}_min`] = stats.min; row[`s${colorIdx}_minId`] = stats.minId;
                              row[`s${colorIdx}_q1`] = stats.q1; row[`s${colorIdx}_q1Id`] = stats.q1Id;
                              row[`s${colorIdx}_median`] = stats.median; row[`s${colorIdx}_medianId`] = stats.medianId;
                              row[`s${colorIdx}_q3`] = stats.q3; row[`s${colorIdx}_q3Id`] = stats.q3Id;
                              row[`s${colorIdx}_max`] = stats.max; row[`s${colorIdx}_maxId`] = stats.maxId;
                              row[`s${colorIdx}_mean`] = stats.mean;
                            });
                            return row;
                          });

                          return (
                            <div key={v} className="bg-white p-4 rounded-xl shadow-sm border border-gray-200" style={deferredSectionStyle}>
                              <div className="flex justify-between items-end mb-3 border-b pb-2 flex-wrap gap-2">
                                <h3 className="font-bold text-lg text-gray-800">
                                  {`${v} vs ${scoreModeLabel}`}
                                  <span className="text-xs bg-gray-200 text-gray-600 px-2 py-1 rounded ml-2">箱ひげ図</span>
                                </h3>
                                <div className="flex gap-4">
                                  {compareSubmissions.map((sub) => {
                                    const ci = subColorMap[sub.id] ?? 0;
                                    return (
                                      <span key={sub.id} className="flex items-center gap-1.5 text-sm font-bold" style={{ color: CHART_COLORS[ci % CHART_COLORS.length] }}>
                                        <span className="inline-block w-3 h-3 rounded-sm" style={{ background: CHART_COLORS[ci % CHART_COLORS.length] }} />
                                        {sub.name}
                                      </span>
                                    );
                                  })}
                                </div>
                              </div>
                              <SvgBoxPlot
                                chartData={chartData}
                                uniqueVals={uniqueVals}
                                compareSubmissions={compareSubmissions}
                                subColorMap={subColorMap}
                                yDomain={yDomain}
                                varName={v}
                                onHover={onHover}
                                onLeave={onLeave}
                                onClickPoint={onClickPoint}
                                hoveredScore={hoveredScore}
                                activeVisScore={activeVisScore}
                              />
                            </div>
                          );
                        }

                        // ── 散布図 ──
                        return (
                          <div key={v} className="bg-white p-4 rounded-xl shadow-sm border border-gray-200" style={deferredSectionStyle}>
                            <div className="flex justify-between items-end mb-3 border-b pb-2 flex-wrap gap-2">
                              <h3 className="font-bold text-lg text-gray-800">{`${v} vs ${scoreModeLabel}`}</h3>
                              <div className="text-sm">
                                <table className="min-w-[200px] text-right">
                                  <thead><tr className="text-gray-500"><th className="font-normal pr-4">提出</th><th className="font-normal">相関係数</th></tr></thead>
                                  <tbody>
                                    {plotData.map((pd) => {
                                      const ci = subColorMap[pd.subId] ?? 0;
                                      return (
                                        <tr key={pd.subName} style={{ color: CHART_COLORS[ci % CHART_COLORS.length] }}>
                                          <td className="pr-4 font-bold">{pd.subName}</td>
                                          <td className="font-mono">{pd.corr.toFixed(3)}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                            <SvgScatterPlot
                              plotData={plotData}
                              yDomain={yDomain}
                              xLabel={v}
                              subColorMap={subColorMap}
                              onHover={onHover}
                              onLeave={onLeave}
                              onClickPoint={onClickPoint}
                              hoveredId={hoveredId}
                              activeVisId={currentVisId}
                            />
                          </div>
                        );
                      })}

                      {/* ── 提出ごとのサマリーテーブル ── */}
                      <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200" style={deferredSectionStyle}>
                        <h3 className="font-bold text-lg text-gray-800 mb-1 border-b pb-2">{`提出サマリー（フィルター適用後 / ${scoreModeLabel}）`}</h3>
                        <p className="text-xs text-gray-400 mb-3">最大・Q3・中央値・Q1・最小はクリックでビジュアライザを開きます</p>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm text-right">
                            <thead>
                              <tr className="text-gray-500 border-b">
                                <th className="text-left py-2 pr-4 font-normal">提出</th>
                                <th className="py-2 px-3 font-normal">件数</th>
                                <th className="py-2 px-3 font-normal">最大</th>
                                <th className="py-2 px-3 font-normal">Q3 (75%)</th>
                                <th className="py-2 px-3 font-normal">中央値</th>
                                <th className="py-2 px-3 font-normal">平均</th>
                                <th className="py-2 px-3 font-normal">Q1 (25%)</th>
                                <th className="py-2 px-3 font-normal">最小</th>
                                <th className="py-2 px-3 font-normal">分散</th>
                              </tr>
                            </thead>
                            <tbody>
                              {compareSubmissions.map((sub) => {
                                const ci = subColorMap[sub.id] ?? 0;
                                const entries = sub.testCases
                                  ?.filter(tc => {
                                    if (typeof seedRange.min === 'number' && tc.id < seedRange.min) return false;
                                    if (typeof seedRange.max === 'number' && tc.id > seedRange.max) return false;
                                    if (showFavoritesOnly && !favorites.has(tc.id)) return false;
                                    if (!passesAbsoluteScoreFilter(tc, varFilters)) return false;
                                    if (!passesVariableFilters(tc, activeVars, testcaseVars, varFilters)) return false;
                                    return true;
                                  })
                                  .map(tc => ({ score: getScoreByMode(tc, statsScoreMode), id: tc.id })) || [];
                                const st = calcBoxStatsWithIds(entries);
                                const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
                                const VisTd = ({ score, id, bold }: { score: number; id: number; bold?: boolean }) => (
                                  <td
                                    className={`py-2 px-3 font-mono cursor-pointer hover:bg-blue-50 hover:text-blue-700 rounded transition-colors ${bold ? 'font-bold' : ''}`}
                                    style={bold ? { color: CHART_COLORS[ci % CHART_COLORS.length] } : { color: '#374151' }}
                                    title={`seed: ${String(id).padStart(4, '0')} → クリックでビジュアライズ`}
                                    onClick={() => openVisualizer(id, sub.id)}
                                  >
                                    {fmt(score)}
                                  </td>
                                );
                                return (
                                  <tr key={sub.id} className="border-b last:border-0 hover:bg-gray-50">
                                    <td className="text-left py-2 pr-4 font-bold" style={{ color: CHART_COLORS[ci % CHART_COLORS.length] }}>{sub.name}</td>
                                    <td className="py-2 px-3 text-gray-600">{entries.length}</td>
                                    <VisTd score={st.max} id={st.maxId} />
                                    <VisTd score={st.q3} id={st.q3Id} />
                                    <VisTd score={st.median} id={st.medianId} bold />
                                    <td className="py-2 px-3 text-gray-700 font-mono">{fmt(st.mean)}</td>
                                    <VisTd score={st.q1} id={st.q1Id} />
                                    <VisTd score={st.min} id={st.minId} />
                                    <td className="py-2 px-3 text-gray-500 font-mono">{fmt(st.variance)}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
              </div>
            </div>
          )}
          {/* ★ ここまで追加 */}

          {/* ── 定数チューニングタブ ── */}
          {activeTab === 'tuning' && (
            <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden p-6 bg-gray-50">
              <div className={visData ? '' : 'max-w-7xl mx-auto w-full'}>
              <h2 className="text-2xl font-bold flex items-center gap-2 text-gray-800 mb-6">
                <Sliders size={28} className="text-purple-600" /> 定数チューニング
                {tuningStatus === 'running' && <span className="text-sm font-normal text-green-600 flex items-center gap-1"><span className="w-2 h-2 bg-green-500 rounded-full animate-pulse inline-block" /> バックグラウンド実行中</span>}
                {tuningStatus === 'paused' && <span className="text-sm font-normal text-yellow-600 flex items-center gap-1"><span className="w-2 h-2 bg-yellow-500 rounded-full inline-block" /> 提出処理のため一時停止中...</span>}
              </h2>

              <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">

                {/* ── 左: 設定パネル ── */}
                <div className="xl:col-span-1 flex flex-col gap-4">

                  <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                    <div className="flex items-center justify-between mb-3 border-b pb-2">
                      <h3 className="font-bold text-gray-700">チューニング用コード</h3>
                      <div className="flex gap-2">
                        <button
                          onClick={async () => {
                            try {
                              let text = '';
                              try { text = await readText() || ''; } catch {}
                              if (!text) text = clipboardCacheRef.current;
                              if (text) setTuningCode(text);
                            } catch (err) { console.error('貼り付け失敗:', err); }
                          }}
                          className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 border border-gray-200 rounded-lg text-xs font-bold transition-colors"
                        >
                          貼り付け
                        </button>
                        <CopyButton text={tuningCode} className="px-3 py-1.5" />
                      </div>
                    </div>
                    <textarea
                      value={tuningCode}
                      onChange={e => setTuningCode(e.target.value)}
                      className="w-full h-56 border border-gray-300 rounded-lg p-3 text-xs font-mono bg-white focus:ring-1 focus:ring-purple-400 outline-none"
                      placeholder="定数チューニング専用のコードを貼り付け"
                    />
                    <p className="text-xs text-gray-400 mt-2">通常の提出コードとは別管理です。ここに貼ったコードでチューニングを回します。</p>
                  </div>

                  <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                    <div className="flex items-center justify-between mb-3 border-b pb-2">
                      <h3 className="font-bold text-gray-700">履歴</h3>
                      {tuningHistory.length > 0 && (
                        <button
                          onClick={() => snapshotCurrentTuningSession(selectedTuningSessionId ?? `tuning_session_${Date.now()}`, { savedAt: Date.now() })}
                          className="px-3 py-1.5 bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 rounded-lg text-xs font-bold transition-colors"
                        >
                          現在状態を保存
                        </button>
                      )}
                    </div>
                    {tuningSessions.length === 0 ? (
                      <p className="text-sm text-gray-400 text-center py-4">保存済み履歴はありません</p>
                    ) : (
                      <div className="space-y-2 max-h-64 overflow-y-auto">
                        {tuningSessions.map(session => {
                          const selected = session.id === selectedTuningSessionId;
                          return (
                            <button
                              key={session.id}
                              onClick={() => loadTuningSession(session)}
                              className={`w-full text-left rounded-lg border p-3 transition-colors ${selected ? 'border-purple-300 bg-purple-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex-1 min-w-0">
                                  <input
                                    type="text"
                                    value={session.name}
                                    onClick={e => e.stopPropagation()}
                                    onChange={e => {
                                      const value = e.target.value;
                                      setTuningSessions(prev => prev.map(s => s.id === session.id ? { ...s, name: value } : s));
                                    }}
                                    onBlur={e => renameTuningSession(session.id, e.target.value || session.name)}
                                    className={`w-full bg-transparent border-b border-transparent hover:border-gray-300 focus:border-purple-400 focus:outline-none text-sm font-bold ${selected ? 'text-purple-700' : 'text-gray-700'}`}
                                  />
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <span className="text-[11px] text-gray-400">{new Date(session.savedAt).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                                  <button
                                    onClick={e => {
                                      e.stopPropagation();
                                      deleteTuningSession(session.id);
                                    }}
                                    className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                                    title="削除"
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                </div>
                              </div>
                              <p className="text-xs text-gray-500 mt-1">best: {session.best ? session.best.score.toLocaleString() : '--'} / iter: {Math.max(0, ...session.history.map(h => h.iteration))}</p>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <p className="text-xs text-gray-400 mt-2">履歴を選んでも、コード・対象定数・実行設定が変わっていれば新しい履歴として開始します。</p>
                  </div>

                  {/* 自動検出 */}
                  <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                    <div className="flex items-center justify-between mb-3 border-b pb-2">
                      <h3 className="font-bold text-gray-700 flex items-center gap-2"><Zap size={16} className="text-yellow-500" /> 定数を検出</h3>
                      <button
                        onClick={() => {
                          const detected = detectConstantsFromCode(tuningCode);
                          if (detected.length === 0) { showStatus('error', '大文字の定数が見つかりませんでした。手動で追加してください。'); return; }
                          setTuningParams(prev => {
                            const existNames = new Set(prev.map(p => p.name));
                            const newOnes = detected.filter(d => !existNames.has(d.name));
                            showStatus('success', `${newOnes.length} 個の定数を追加しました`);
                            return [...prev, ...newOnes];
                          });
                        }}
                        className="px-3 py-1.5 bg-yellow-50 hover:bg-yellow-100 text-yellow-700 border border-yellow-200 rounded-lg text-xs font-bold transition-colors flex items-center gap-1"
                      >
                        <RefreshCw size={12} /> コードから検出
                      </button>
                    </div>
                    <p className="text-xs text-gray-400">上のチューニング用コードから大文字定数 (<code>CONST_NAME = 値</code>) を自動検出します。</p>
                  </div>

                  {/* 手動追加 */}
                  <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                    <div className="flex items-center justify-between mb-3 border-b pb-2">
                      <h3 className="font-bold text-gray-700">チューニング対象</h3>
                      <button
                        onClick={() => setTuningParams(prev => [...prev, {
                          id: `param_${Date.now()}`, name: '', currentValue: 100, minValue: 10, maxValue: 1000, divisions: 5, paramType: 'int'
                        }])}
                        className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded-lg text-xs font-bold transition-colors flex items-center gap-1"
                      >
                        <Plus size={12} /> 追加
                      </button>
                    </div>
                    {tuningParams.length === 0 ? (
                      <p className="text-sm text-gray-400 text-center py-4">パラメータがありません</p>
                    ) : (
                      <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                        {tuningParams.map((p, i) => (
                          <div key={p.id} className="bg-gray-50 rounded-lg p-3 border border-gray-200 text-xs">
                            <div className="flex items-center gap-2 mb-2">
                              <input
                                type="text"
                                placeholder="定数名 (例: BEAM_WIDTH)"
                                value={p.name}
                                onChange={e => setTuningParams(prev => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                                className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs font-mono font-bold focus:ring-1 focus:ring-blue-400 outline-none"
                              />
                              <select value={p.paramType} onChange={e => setTuningParams(prev => prev.map((x, j) => j === i ? { ...x, paramType: e.target.value as 'int' | 'float' } : x))}
                                className="border border-gray-300 rounded px-1 py-1 text-xs bg-white">
                                <option value="int">int</option>
                                <option value="float">float</option>
                              </select>
                              <button onClick={() => setTuningParams(prev => prev.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600 p-1 rounded hover:bg-red-50 transition-colors"><Trash2 size={13} /></button>
                            </div>
                            <TuningRangeSlider
                              param={p}
                              onChange={(next) => setTuningParams(prev => prev.map((x, j) => {
                                if (j !== i) return x;
                                const merged = { ...x, ...next };
                                if (merged.currentValue < merged.minValue) merged.currentValue = merged.minValue;
                                if (merged.currentValue > merged.maxValue) merged.currentValue = merged.maxValue;
                                return merged;
                              }))}
                            />
                            <div className="grid grid-cols-3 gap-1.5 mt-3">
                              {[
                                ['現在値', 'currentValue'],
                                ['自動ステップ', 'autoStep'],
                                ['分割数', 'divisions'],
                              ].map(([label, key]) => (
                                <div key={key}>
                                  <p className="text-gray-400 mb-0.5">{label}</p>
                                  {key === 'autoStep' ? (
                                    <div className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs bg-gray-100 font-mono text-gray-600">
                                      {p.paramType === 'float' ? getTuningStepSize(p).toFixed(4).replace(/\.?0+$/, '') : getTuningStepSize(p).toLocaleString()}
                                    </div>
                                  ) : (
                                    <input
                                      type="number"
                                      min={key === 'divisions' ? 1 : undefined}
                                      step={key === 'divisions' ? '1' : p.paramType === 'float' ? '0.01' : '1'}
                                      value={(p as any)[key]}
                                      onChange={e => setTuningParams(prev => prev.map((x, j) => {
                                        if (j !== i) return x;
                                        const raw = key === 'divisions'
                                          ? Math.max(1, parseInt(e.target.value) || 1)
                                          : p.paramType === 'float'
                                            ? parseFloat(e.target.value) || 0
                                            : parseInt(e.target.value) || 0;
                                        return { ...x, [key]: raw };
                                      }))}
                                      className="w-full border border-gray-300 rounded px-1.5 py-1 text-xs bg-white font-mono focus:ring-1 focus:ring-blue-400 outline-none"
                                    />
                                  )}
                                </div>
                              ))}
                            </div>
                            <div className="grid grid-cols-2 gap-1.5 mt-2">
                              {[
                                ['最小', 'minValue'],
                                ['最大', 'maxValue'],
                              ].map(([label, key]) => (
                                <div key={key}>
                                  <p className="text-gray-400 mb-0.5">{label}</p>
                                  <input
                                    type="number"
                                    step={p.paramType === 'float' ? '0.01' : '1'}
                                    value={(p as any)[key]}
                                    onChange={e => setTuningParams(prev => prev.map((x, j) => {
                                      if (j !== i) return x;
                                      const value = p.paramType === 'float' ? parseFloat(e.target.value) || 0 : parseInt(e.target.value) || 0;
                                      const merged = { ...x, [key]: value };
                                      if (merged.minValue > merged.maxValue) {
                                        if (key === 'minValue') merged.maxValue = value;
                                        else merged.minValue = value;
                                      }
                                      if (merged.currentValue < merged.minValue) merged.currentValue = merged.minValue;
                                      if (merged.currentValue > merged.maxValue) merged.currentValue = merged.maxValue;
                                      return merged;
                                    }))}
                                    className="w-full border border-gray-300 rounded px-1.5 py-1 text-xs bg-white font-mono focus:ring-1 focus:ring-blue-400 outline-none"
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 実行設定 */}
                  <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                    <h3 className="font-bold text-gray-700 border-b pb-2 mb-3">実行設定</h3>
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs font-bold text-gray-500 block mb-1">1反復あたりのテストケース数</label>
                        <input type="number" min={1} max={testCases} value={tuningTestCases}
                          onChange={e => setTuningTestCases(Math.max(1, Math.min(testCases, Number(e.target.value))))}
                          className="border rounded p-1.5 w-full text-sm bg-white font-mono"
                        />
                        <p className="text-xs text-gray-400 mt-1">現在の提出設定: {testCases} ケース</p>
                      </div>
                      <div>
                        <label className="text-xs font-bold text-gray-500 block mb-1">並列数</label>
                        <input
                          type="number"
                          min={1}
                          value={parallelism}
                          onChange={e => setParallelism(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                          className="border rounded p-1.5 w-full text-sm bg-white font-mono"
                        />
                        <p className="text-xs text-gray-400 mt-1">既定値は 論理プロセッサ数 ({logicalProcessorCount}) - 1 です。</p>
                        {parallelism > logicalProcessorCount && (
                          <p className="text-xs text-amber-600 font-bold mt-1">論理プロセッサ数を超えています。処理能力が下がることがあります。</p>
                        )}
                      </div>
                      <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
                        <p className="text-xs font-bold text-gray-500">総組み合わせ数</p>
                        <p className="text-lg font-mono font-bold text-purple-700">{tuningTotalCombos.toLocaleString()}</p>
                        <p className="text-[11px] text-gray-400 mt-0.5">粗く探索してから有望領域を先に細かく見て、その後に残りを回します。</p>
                      </div>
                    </div>

                    <div className="mt-4 flex gap-2">
                      {tuningStatus === 'idle' ? (
                        <button
                          onClick={startTuning}
                          disabled={tuningCode.trim().length === 0 || tuningParams.length === 0 || tuningParams.some(p => !p.name.trim())}
                          className="flex-1 px-4 py-2.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white font-bold rounded-lg flex items-center justify-center gap-2 transition-colors shadow-sm"
                        >
                          <Zap size={16} /> {canResumeSelectedTuningSession ? 'チューニング再開' : 'チューニング開始'}
                        </button>
                      ) : (
                        <button
                          onClick={stopTuning}
                          className="flex-1 px-4 py-2.5 bg-red-500 hover:bg-red-600 text-white font-bold rounded-lg flex items-center justify-center gap-2 transition-colors shadow-sm"
                        >
                          <StopCircle size={16} /> 停止
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-2 text-center">別タブに移動しても実行継続。提出時は自動で一時停止→再開します。</p>
                  </div>
                </div>

                {/* ── 右: 進捗・結果パネル ── */}
                <div className="xl:col-span-2 flex flex-col gap-4">

                  {/* 進捗カード */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[
                      { label: '反復数', value: tuningIterCount.toString(), sub: null, color: 'text-gray-800' },
                      { label: '経過時間', value: `${Math.floor(tuningElapsedSec / 60)}:${String(tuningElapsedSec % 60).padStart(2, '0')}`, sub: null, color: 'text-gray-800' },
                      { label: '1反復の平均時間', value: tuningAvgIterSec != null ? `${tuningAvgIterSec.toFixed(1)}s` : '--', sub: null, color: 'text-blue-700' },
                      { label: 'ベストスコア', value: tuningBest ? tuningBest.score.toLocaleString() : '--', sub: tuningBest ? `iter ${tuningBest.iteration}` : null, color: 'text-purple-700' },
                    ].map(card => (
                      <div key={card.label} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex flex-col gap-1">
                        <p className="text-xs text-gray-500 font-bold">{card.label}</p>
                        <p className={`text-2xl font-mono font-bold ${card.color}`}>{card.value}</p>
                        {card.sub && <p className="text-xs text-gray-400">{card.sub}</p>}
                      </div>
                    ))}
                  </div>

                  {/* ベストパラメータ */}
                  {tuningBest && (
                    <div className="bg-white rounded-xl shadow-sm border border-purple-200 p-4">
                      <div className="flex items-center justify-between mb-3 border-b border-purple-100 pb-2">
                        <h3 className="font-bold text-purple-700 flex items-center gap-2"><TrendingUp size={16} /> ベスト構成 (iter {tuningBest.iteration})</h3>
                        <CopyButton
                          text={buildCodeWithTuningParams(tuningCode, tuningParams, tuningBest.params)}
                          className="px-3 py-1.5"
                        />
                      </div>
                      <div className="flex flex-wrap gap-3">
                        {tuningParams.map(p => (
                          <div key={p.id} className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 min-w-[120px]">
                            <p className="text-xs text-purple-500 font-bold font-mono">{p.name}</p>
                            <p className="text-lg font-mono font-bold text-purple-800">
                              {p.paramType === 'float'
                                ? (tuningBest.params[p.name] ?? p.currentValue).toFixed(4)
                                : (tuningBest.params[p.name] ?? p.currentValue).toLocaleString()
                              }
                            </p>
                            <p className="text-xs text-purple-400">初期: {p.currentValue}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 履歴グラフ + テーブル */}
                  <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                    <h3 className="font-bold text-gray-700 border-b pb-2 mb-3 flex items-center gap-2"><BarChart2 size={16} /> 反復履歴 (最新100件)</h3>
                    {tuningHistory.length === 0 ? (
                      <p className="text-sm text-gray-400 text-center py-8">{tuningStatus === 'idle' ? 'チューニングを開始してください' : '実行中...'}</p>
                    ) : (
                      <>
                        {/* ミニチャート */}
                        {(() => {
                          const data = [...tuningHistory].reverse();
                          const scores = data.map(d => d.score);
                          const minS = Math.min(...scores), maxS = Math.max(...scores);
                          const range = maxS === minS ? 1 : maxS - minS;
                          const W = 560, H = 120, ML = 50, MB = 20, MT = 8, MR = 8;
                          const iW = W - ML - MR, iH = H - MB - MT;
                          const toX = (i: number) => ML + (i / Math.max(1, data.length - 1)) * iW;
                          const toY = (s: number) => MT + (1 - (s - minS) / range) * iH;
                          const pts = data.map((d, i) => `${toX(i)},${toY(d.score)}`).join(' ');
                          const bestScoreInHistory = config?.optimize_target === 'minimize' ? Math.min(...scores) : Math.max(...scores);
                          return (
                            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H, display: 'block' }} className="mb-3">
                              <line x1={ML} y1={MT} x2={ML} y2={H - MB} stroke="#d1d5db" strokeWidth={1} />
                              <line x1={ML} y1={H - MB} x2={W - MR} y2={H - MB} stroke="#d1d5db" strokeWidth={1} />
                              {[0, 0.5, 1].map((t, i) => {
                                const y = MT + (1 - t) * iH;
                                const val = minS + t * range;
                                return <g key={i}><line x1={ML} y1={y} x2={W - MR} y2={y} stroke="#f3f4f6" strokeWidth={1} /><text x={ML - 4} y={y + 4} textAnchor="end" fontSize={9} fill="#9ca3af">{Math.round(val).toLocaleString()}</text></g>;
                              })}
                              <polyline points={pts} fill="none" stroke="#8b5cf6" strokeWidth={1.5} strokeOpacity={0.7} />
                              {data.map((d, i) => d.score === bestScoreInHistory ? <circle key={i} cx={toX(i)} cy={toY(d.score)} r={4} fill="#7c3aed" /> : null)}
                              {tuningBest && (() => {
                                const bestIdx = data.findIndex(d => d.iteration === tuningBest!.iteration);
                                if (bestIdx < 0) return null;
                                return <circle cx={toX(bestIdx)} cy={toY(tuningBest.score)} r={5} fill="#7c3aed" stroke="white" strokeWidth={2} />;
                              })()}
                            </svg>
                          );
                        })()}

                        {/* 履歴テーブル */}
                        <div className="max-h-64 overflow-y-auto">
                          <table className="w-full text-xs text-right">
                            <thead className="sticky top-0 bg-white">
                              <tr className="text-gray-400 border-b">
                                <th className="py-1.5 px-2 text-left font-normal">iter</th>
                                <th className="py-1.5 px-2 font-normal">スコア</th>
                                {tuningParams.map(p => <th key={p.id} className="py-1.5 px-2 font-mono font-normal">{p.name}</th>)}
                              </tr>
                            </thead>
                            <tbody>
                              {tuningHistory.map((h, i) => {
                                const isBestRow = tuningBest && h.iteration === tuningBest.iteration;
                                return (
                                  <tr key={i} className={`border-b last:border-0 ${isBestRow ? 'bg-purple-50' : 'hover:bg-gray-50'}`}>
                                    <td className="py-1.5 px-2 text-left text-gray-500 font-mono">#{h.iteration}</td>
                                    <td className={`py-1.5 px-2 font-mono font-bold ${isBestRow ? 'text-purple-700' : 'text-gray-700'}`}>
                                      {h.score.toLocaleString()} {isBestRow && '★'}
                                    </td>
                                    {tuningParams.map(p => (
                                      <td key={p.id} className="py-1.5 px-2 font-mono text-gray-600">
                                        {p.paramType === 'float' ? (h.params[p.name] ?? '?').toString().slice(0, 8) : h.params[p.name] ?? '?'}
                                      </td>
                                    ))}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
              </div>
            </div>
          )}

        </div>

        {/* ★ ここから追加：設定＆ケース生成モーダル */}
        {isSettingsOpen && editingConfig && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-8 backdrop-blur-sm">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-xl max-h-[85vh] overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col">
              <div className="p-4 bg-gray-100 border-b flex justify-between items-center">
                <h3 className="text-lg font-bold flex items-center gap-2 text-gray-800">
                  <Settings size={20} className="text-gray-600" />
                  {currentContest} のコンテスト設定
                </h3>
              </div>

              <div className="p-6 space-y-6 overflow-y-auto">
                {/* ★ 追加: コンテスト名の変更欄 */}
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">コンテスト名</label>
                  <input
                    type="text"
                    value={editingConfig.name}
                    onChange={(e) => setEditingConfig({ ...editingConfig, name: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg p-2 focus:ring-2 focus:ring-blue-500 focus:outline-none font-bold"
                  />
                </div>

                {/* 最適化の方向 */}
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-2">最適化の目標</label>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" checked={editingConfig.optimize_target === 'maximize'} onChange={() => setEditingConfig({ ...editingConfig, optimize_target: 'maximize' })} className="w-4 h-4 text-blue-600" />
                      <span>最大化 (Maximize)</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" checked={editingConfig.optimize_target === 'minimize'} onChange={() => setEditingConfig({ ...editingConfig, optimize_target: 'minimize' })} className="w-4 h-4 text-blue-600" />
                      <span>最小化 (Minimize)</span>
                    </label>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-2">得点表示</label>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        checked={(editingConfig.score_display ?? 'sum') === 'sum'}
                        onChange={() => setEditingConfig({ ...editingConfig, score_display: 'sum' })}
                        className="w-4 h-4 text-blue-600"
                      />
                      <span>総和</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        checked={(editingConfig.score_display ?? 'sum') === 'average'}
                        onChange={() => setEditingConfig({ ...editingConfig, score_display: 'average' })}
                        className="w-4 h-4 text-blue-600"
                      />
                      <span>平均</span>
                    </label>
                  </div>
                </div>

                {/* 変数フォーマット */}
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">入力1行目の変数 (スペース区切り)</label>
                  <p className="text-xs text-gray-500 mb-2">例: N M T U （散布図の表示などに使用されます）</p>
                  <input
                    type="text"
                    value={editingConfig.variables}
                    onChange={(e) => setEditingConfig({ ...editingConfig, variables: e.target.value })}
                    placeholder="N M"
                    className="w-full border border-gray-300 rounded-lg p-2 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  />
                </div>

                {/* toolsディレクトリ指定（ZIPから再設定） */}
                <div className="pt-2">
                  <label className="block text-sm font-bold text-gray-700 mb-1">toolsの再設定</label>
                  <p className="text-xs text-gray-500 mb-3">公式の配布ツール(ZIP)を選択して上書き展開します。</p>
                  <button
                    onClick={handleSelectToolsZip}
                    disabled={isProcessing || !!editingConfig.archived}
                    className="px-4 py-2 bg-white hover:bg-gray-50 text-gray-700 rounded-lg border border-gray-300 shadow-sm transition-colors flex items-center gap-2 font-bold disabled:opacity-50"
                  >
                    <Folder size={18} className="text-blue-500" />
                    {isProcessing ? '展開中...' : 'ZIPファイルを参照して展開...'}
                  </button>
                </div>

                {/* ビジュアライザキャッシュ再ダウンロード */}
                <div className="pt-2">
                  <label className="block text-sm font-bold text-gray-700 mb-1">ビジュアライザの再ダウンロード</label>
                  <p className="text-xs text-gray-500 mb-3">キャッシュを削除し、次回起動時に再取得します。</p>
                  <button
                    onClick={async () => {
                      if (!currentContest) return;
                      try {
                        await invoke('reset_visualizer_cache', { contestName: currentContest });
                        showStatus('success', 'ビジュアライザのキャッシュを削除しました。次回ビジュアライズ時に再ダウンロードされます。');
                      } catch (e) {
                        showStatus('error', 'キャッシュ削除に失敗しました: ' + String(e));
                      }
                    }}
                    disabled={isProcessing || !!editingConfig.archived}
                    className="px-4 py-2 bg-white hover:bg-gray-50 text-gray-700 rounded-lg border border-gray-300 shadow-sm transition-colors flex items-center gap-2 font-bold disabled:opacity-50"
                  >
                    <Eye size={18} className="text-purple-500" />
                    キャッシュを削除して再ダウンロード
                  </button>
                </div>

                {/* ケース生成機能 */}
                <div className="pt-4 border-t">
                  <label className="block text-sm font-bold text-gray-700 mb-2">テストケース再生成 (tools/gen)</label>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 bg-gray-100 p-2 rounded-lg border border-gray-300">
                      <span className="text-sm font-bold text-gray-600">Cases:</span>
                      <input type="number" min="1" max="1000" value={testCases} onChange={e => setTestCases(Number(e.target.value))} className="w-16 bg-transparent outline-none font-bold text-gray-800" />
                    </div>
                    <button
                      onClick={() => { handleGenerateInputs(); setIsSettingsOpen(false); }}
                      disabled={!!editingConfig.archived}
                      className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg flex items-center gap-2 font-bold shadow-sm transition-colors"
                    >
                      <Plus size={16} /> 生成を実行
                    </button>
                  </div>
                </div>
              </div>

              <div className="p-4 border-t bg-gray-50 flex justify-end gap-3">
                <button onClick={() => setIsSettingsOpen(false)} className="px-5 py-2 font-bold text-gray-600 bg-gray-200 hover:bg-gray-300 rounded-lg transition-colors">キャンセル</button>
                <button onClick={saveSettings} className="px-5 py-2 font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-md transition-colors flex items-center gap-2">
                  <Settings size={18} /> 設定を保存
                </button>
              </div>
            </div>
          </div>
        )}
        {isGlobalSettingsOpen && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-8 backdrop-blur-sm">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-xl max-h-[85vh] overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col">
              <div className="p-4 bg-gray-100 border-b flex justify-between items-center">
                <h3 className="text-lg font-bold flex items-center gap-2 text-gray-800">
                  <Settings size={20} className="text-gray-600" />
                  グローバル設定
                </h3>
              </div>

              <div className="p-6 space-y-6 overflow-y-auto">
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">
                    ファイルダイアログの初期フォルダ
                  </label>
                  <p className="text-xs text-gray-500 mb-2">
                    ZIPを選択するダイアログが開く場所です。WSL環境でWindowsのCドライブを参照する場合は{' '}
                    <code className="bg-gray-100 px-1 rounded font-mono">/mnt/c/</code> などを指定してください。
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={dialogDefaultPath}
                      onChange={e => setDialogDefaultPath(e.target.value)}
                      placeholder="/mnt/c/"
                      className="flex-1 border border-gray-300 rounded-lg p-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    />
                    <button
                      onClick={() => setDialogDefaultPath('/mnt/c/')}
                      className="px-3 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg text-xs font-bold border border-gray-300 transition-colors whitespace-nowrap"
                    >
                      C: ドライブ
                    </button>
                    <button
                      onClick={() => setDialogDefaultPath('/mnt/d/')}
                      className="px-3 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg text-xs font-bold border border-gray-300 transition-colors whitespace-nowrap"
                    >
                      D: ドライブ
                    </button>
                  </div>
                </div>

                <div className="pt-4 border-t">
                  <label className="block text-sm font-bold text-gray-700 mb-1">並列実行数</label>
                  <p className="text-xs text-gray-500 mb-2">
                    提出実行と定数チューニングの両方で使います。既定値は 論理プロセッサ数 ({logicalProcessorCount}) - 1 です。
                  </p>
                  <input
                    type="number"
                    min={1}
                    value={parallelism}
                    onChange={e => setParallelism(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                    className="w-full border border-gray-300 rounded-lg p-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  />
                  {parallelism > logicalProcessorCount && (
                    <p className="text-xs text-amber-600 font-bold mt-2">
                      論理プロセッサ数 ({logicalProcessorCount}) を超えています。文脈切替やメモリ競合で遅くなることがあります。
                    </p>
                  )}
                </div>
              </div>

              <div className="p-4 border-t bg-gray-50 flex justify-end gap-3">
                <button onClick={() => setIsGlobalSettingsOpen(false)} className="px-5 py-2 font-bold text-gray-600 bg-gray-200 hover:bg-gray-300 rounded-lg transition-colors">閉じる</button>
              </div>
            </div>
          </div>
        )}
        {/* ★ ここまで追加 */}

        {/* 右側エリア（ビジュアライザ）— 独立スクロール不可・高さ固定 */}
        {visData && (
          <div className="w-[50%] min-w-[440px] max-w-[60%] min-h-0 border-l border-gray-300 bg-white flex flex-col overflow-hidden shadow-[-8px_0_16px_-8px_rgba(0,0,0,0.08)] z-10">
            <div className="p-3 bg-gray-50 border-b flex justify-between items-center gap-3 flex-wrap flex-none">
              <div className="flex items-center gap-4 flex-wrap">
                <h3 className="font-bold flex items-center gap-2 text-gray-800"><Eye size={18} className="text-blue-500" /> Visualizer</h3>
                {visData.web_url && (
                  <button onClick={handleOpenWebVis} className="text-blue-600 hover:text-blue-800 text-sm font-bold flex items-center gap-1 underline transition-colors" title="外部ブラウザで開く">
                    <ExternalLink size={14} /> ブラウザで開く
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                <div className="flex items-center gap-1 rounded-md border border-gray-300 bg-white p-1">
                  {[50, 67, 75, 90, 100, 125, 150, 200].map((value) => (
                    <button
                      key={value}
                      onClick={() => setVisZoom(value)}
                      className={`px-2 py-1 rounded text-xs font-bold transition-colors ${visZoom === value ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
                    >
                      {value}%
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => { setVisZoom(90); }}
                  className="px-3 py-1.5 bg-white hover:bg-gray-100 text-gray-700 rounded-md border border-gray-300 font-bold transition-colors text-xs"
                >
                  表示リセット
                </button>
                <button onClick={() => { setVisDataSynced(null); setCurrentVisId(null); }} className="px-4 py-1.5 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-md font-bold transition-colors text-sm">閉じる</button>
              </div>
            </div>
            <div className="flex-1 overflow-x-auto overflow-y-auto bg-gray-100 p-3">
              <div className="h-full min-h-[480px] min-w-full">
                <div
                  className="relative h-full min-h-[480px] overflow-hidden rounded-lg border border-gray-300 bg-white shadow-sm"
                  style={{
                    width: `${visOuterScale * 100}%`,
                    minWidth: '100%',
                  }}
                >
                  {visData.local_url ? (
                    <iframe
                      ref={visIframeRef}
                      src={visData.local_url}
                      className="absolute left-0 top-0 border-0 bg-white"
                      style={{
                        width: `${visInnerBase}%`,
                        height: `${visInnerBase}%`,
                        minHeight: '100%',
                        transform: `scale(${visScale})`,
                        transformOrigin: 'top left',
                      }}
                    />
                  ) : (
                    <iframe
                      ref={visIframeRef}
                      srcDoc={visData.html}
                      className="absolute left-0 top-0 border-0 bg-white"
                      style={{
                        width: `${visInnerBase}%`,
                        height: `${visInnerBase}%`,
                        minHeight: '100%',
                        transform: `scale(${visScale})`,
                        transformOrigin: 'top left',
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

      </main>
      <StatusBar />
      {confirmDialog && (
        <ConfirmDialog
          message={confirmDialog.message}
          subMessage={confirmDialog.subMessage}
          confirmLabel={confirmDialog.confirmLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </div>
  );
}

export default App;
