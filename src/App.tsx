import React, { useState, useEffect, useRef, useMemo } from 'react';
import Editor from '@monaco-editor/react';
import { Code2, Play, LayoutList, Settings, Plus, Folder, ArrowLeft, Loader2, CheckCircle2, AlertCircle, Trophy, Edit2, Clock, Trash2, FileCode2, Eye, ExternalLink, BarChart2, Copy, Check } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

type TestCaseResult = { id: number; score: number; status: string; time: number; error_msg: string; };

type Submission = {
  id: string; timestamp: number; time: string; name: string; totalScore: number; codeLength: number;
  status: string; memory: string; execTime: number; code: string; language: string; testCases: TestCaseResult[];
};

type VisData = { html: string; input: string; output: string; stderr: string; web_url: string | null; local_url: string | null };

type ContestConfig = {
  name: string;
  tools_dir: string;
  optimize_target: 'minimize' | 'maximize';
  variables: string;
};

// --- ↓ ユーティリティ関数 ↓ ---
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
type ContestItem = { name: string; updated_at: number };

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

function App() {
  const visIframeRef = useRef<HTMLIFrameElement>(null);
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

  const showConfirm = (message: string, subMessage: string | undefined, onConfirm: () => void, confirmLabel?: string) => {
    setConfirmDialog({ message, subMessage, onConfirm, confirmLabel });
  };

  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<{ type: 'info' | 'success' | 'error', message: string } | null>(null);

  const [submissionsMap, setSubmissionsMap] = useState<Record<string, Submission[]>>({});
  const [selectedSubId, setSelectedSubId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'results' | 'code'>('results');

  const [visData, setVisData] = useState<VisData | null>(null);
  const visDataRef = useRef<VisData | null>(null);
  const setVisDataSynced = (data: VisData | null) => {
    visDataRef.current = data;
    setVisData(data);
  };
  // タブを切り替えたらビジュアライザを自動的に閉じる
  useEffect(() => { setVisDataSynced(null); setCurrentVisSubId(null); }, [activeTab]);

  const [memos, setMemos] = useState<Record<string, string>>({});

  const [config, setConfig] = useState<ContestConfig | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<ContestConfig | null>(null);

  const [testcaseVars, setTestcaseVars] = useState<Record<number, Record<string, number>>>({});

  // ★ ここから追加：ソートとスコア計算のための状態・処理
  // 提出一覧のソート状態
  const [submissionSort, setSubmissionSort] = useState<{ key: string; order: 'asc' | 'desc' }>({ key: 'timestamp', order: 'desc' });
  // テストケース一覧のソート状態
  const [testCaseSort, setTestCaseSort] = useState<{ key: string; order: 'asc' | 'desc' }>({ key: 'id', order: 'asc' });
  // テストケースごとの入出力展開状態
  const [expandedCaseIO, setExpandedCaseIO] = useState<Record<number, { input: string; output: string; stderr: string } | 'loading'>>({});

  // ★ 追加: 統計タブ用のState
  const [selectedForStats, setSelectedForStats] = useState<Set<string>>(new Set());
  const [varFilters, setVarFilters] = useState<Record<string, { min: number | '', max: number | '' }>>({});
  // 統計グラフ上のポイントhoverツールチップ
  const [statsPointTooltip, setStatsPointTooltip] = useState<HoverInfo | null>(null);
  const [currentVisId, setCurrentVisId] = useState<number | null>(null);
  const [currentVisSubId, setCurrentVisSubId] = useState<string | null>(null);
  // X軸モード: 'auto'=変数ごと | 'seed'=seed軸折れ線
  const [statsXAxisMode, setStatsXAxisMode] = useState<'auto' | 'seed'>('auto');
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

  // ★ 追加: コンテストが切り替わったら統計の選択状態をリセットする
  useEffect(() => {
    setSelectedForStats(new Set());
    setVarFilters({});
  }, [currentContest]);

  // 提出の選択が変わったら展開中のIOをリセット
  useEffect(() => {
    setExpandedCaseIO({});
  }, [selectedSubId]);

  // submissions を先に計算
  const submissions = currentContest ? (submissionsMap[currentContest] || []) : [];

  // 1. 各テストケースの「ベストスコア」を全提出から算出する
  const bestScores = useMemo(() => {
    const best: Record<number, number> = {};
    if (!submissions || submissions.length === 0) return best;

    const isMin = config?.optimize_target === 'minimize';

    submissions.forEach(sub => {
      sub.testCases?.forEach(tc => {
        // エラー(スコア0やマイナス)を除外したい場合は条件を足せますが、一旦すべての有効なスコアを対象にします
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
  const calcRelativeScore = (score: number, bestScore: number | undefined) => {
    if (bestScore === undefined) return 0;
    const isMin = config?.optimize_target === 'minimize';
    // ご要望の計算式: 10^5 * ...
    const rel = isMin
      ? 1e5 * (1 + bestScore) / (1 + score)
      : 1e5 * (1 + score) / (1 + bestScore);
    return Math.round(rel);
  };

  // 3. 提出一覧（ソート＆相対スコア合計付き）
  const sortedSubmissions = useMemo(() => {
    if (!submissions) return [];

    // 各提出に「合計相対スコア」を付与
    const mapped = submissions.map(sub => {
      const totalRelScore = sub.testCases?.reduce((acc, tc) => acc + calcRelativeScore(tc.score, bestScores[tc.id]), 0) || 0;
      return { ...sub, totalRelScore };
    });

    // 指定されたキーでソート
    return mapped.sort((a, b) => {
      let valA: any = a[submissionSort.key as keyof typeof a];
      let valB: any = b[submissionSort.key as keyof typeof b];

      if (valA < valB) return submissionSort.order === 'asc' ? -1 : 1;
      if (valA > valB) return submissionSort.order === 'asc' ? 1 : -1;
      return 0;
    });
  }, [submissions, submissionSort, bestScores, config?.optimize_target]);
  // ★ ここまで追加

  const handleSubmissionSort = (key: string) => {
    setSubmissionSort(prev => ({
      key, order: prev.key === key && prev.order === 'desc' ? 'asc' : 'desc'
    }));
  };

  const handleTestCaseSort = (key: string) => {
    setTestCaseSort(prev => ({
      key, order: prev.key === key && prev.order === 'desc' ? 'asc' : 'desc'
    }));
  };

  useEffect(() => { loadContests(); }, []);
  useEffect(() => {
    if (currentContest) {
      invoke<ContestConfig>('get_contest_config', { contestName: currentContest })
        .then(data => setConfig(data))
        .catch(e => console.error("設定読み込みエラー:", e));
      invoke<Record<string, string>>('get_testcase_memos', { contestName: currentContest })
        .then(data => setMemos(data))
        .catch(console.error);
    } else {
      setConfig(null);
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

  const saveSettings = async () => {
    if (!currentContest || !editingConfig) return;
    try {
      // ★ 追加: コンテスト名が変更された場合の処理
      const newName = editingConfig.name.trim();
      if (newName && newName !== currentContest) {
        await invoke('rename_contest', { oldName: currentContest, newName: newName });

        // 画面上のリストや現在のコンテスト名も新しいものに更新
        setContests(prev => prev.map(c =>
          c.name === currentContest ? { ...c, name: newName, updated_at: Math.floor(Date.now() / 1000) } : c
        ));
        setCurrentContest(newName);
      }

      // 既存の設定保存処理（リネームされている可能性があるので newName を使う）
      await invoke('save_contest_config', { contestName: newName || currentContest, config: editingConfig });

      setConfig(editingConfig);
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
        title: "toolsのZIPファイルを選択してください"
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
          const parsed = JSON.parse(res);
          setSubmissionsMap(prev => ({ ...prev, [currentContest]: parsed }));
        }).catch(console.error);
    }
  }, [currentContest]);

  const saveSubmissions = async (contest: string, data: Submission[]) => {
    try { await invoke('save_submissions', { contestName: contest, data: JSON.stringify(data) }); }
    catch (e) { console.error(e); }
  };

  const showStatus = (type: 'info' | 'success' | 'error', message: string) => {
    setStatus({ type, message });
    if (type === 'success') setTimeout(() => setStatus(null), 5000);
  };

  const loadContests = async () => {
    try { const list = await invoke<ContestItem[]>('get_contests'); setContests(list); } catch (e) { console.error(e); }
  };

  const handleCreateContest = async () => {
    if (!newContestName.trim()) { showStatus('error', 'コンテスト名を入力してください'); return; }
    try {
      const selected = await open({ multiple: false, filters: [{ name: 'ZIP', extensions: ['zip'] }] });
      if (selected && typeof selected === 'string') {
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
      }
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

  const handleDeleteSubmission = (e: React.MouseEvent, subId: string) => {
    e.stopPropagation();
    showConfirm(
      'この提出を削除しますか？',
      undefined,
      () => {
        setConfirmDialog(null);
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
      showStatus('success', result);
    } catch (error) { showStatus('error', String(error)); }
    finally { setIsProcessing(false); }
  };

  const handleSubmit = async () => {
    if (!currentContest) return;
    setIsProcessing(true);
    showStatus('info', 'コンパイル・準備中...');

    try {
      await invoke('setup_submission', { contestName: currentContest, code: code, language: language, testCases: testCases });

      const subId = Date.now().toString();
      const newSub: Submission = {
        id: subId, timestamp: Date.now(),
        time: new Date().toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        name: `提出 ${submissions.length + 1}`, totalScore: 0, codeLength: new Blob([code]).size,
        status: `Running... (0/${testCases})`, memory: '-', execTime: 0, code: code, language: language, testCases: []
      };

      setSubmissionsMap(prev => {
        const list = prev[currentContest] || [];
        return { ...prev, [currentContest]: [newSub, ...list] };
      });

      setSelectedSubId(null);
      setActiveTab('submissions');
      showStatus('info', 'テストケース並列実行中...');

      let runningScore = 0; let maxTime = 0; let completedCases = 0;
      const resultsArr: TestCaseResult[] = [];

      const updateState = () => {
        setSubmissionsMap(prev => {
          const list = prev[currentContest] || [];
          return {
            ...prev,
            [currentContest]: list.map(s => {
              if (s.id === subId) {
                return { ...s, totalScore: runningScore, execTime: maxTime, status: `Running... (${completedCases}/${testCases})`, testCases: [...resultsArr].sort((a, b) => a.id - b.id) };
              }
              return s;
            })
          };
        });
      };

      const runQueue = async (queue: number[]) => {
        while (queue.length > 0) {
          const i = queue.shift();
          if (i === undefined) break;

          let res: TestCaseResult;
          try {
            res = await invoke<TestCaseResult>('run_test_case', { contestName: currentContest, language: language, caseId: i, timeLimit: timeLimit, memoryLimit: memoryLimit, submissionId: subId });
          } catch (e) { res = { id: i, score: 0, status: 'IE', time: 0, error_msg: String(e) }; }

          runningScore += res.score;
          maxTime = Math.max(maxTime, res.time);
          resultsArr.push(res);
          completedCases++;
          updateState();
        }
      };

      const concurrency = navigator.hardwareConcurrency ? Math.max(1, navigator.hardwareConcurrency) : 4;
      const queue = Array.from({ length: testCases }, (_, i) => i);
      const workers = [];
      for (let i = 0; i < concurrency; i++) { workers.push(runQueue(queue)); }
      await Promise.all(workers);

      const hasIE = resultsArr.some(r => r.status === 'IE');
      const hasMLE = resultsArr.some(r => r.status === 'MLE');
      const hasTLE = resultsArr.some(r => r.status === 'TLE');
      const hasRE = resultsArr.some(r => r.status === 'RE');
      const hasWA = resultsArr.some(r => r.status === 'WA');
      const finalStatus = hasIE ? 'IE' : hasMLE ? 'MLE' : hasTLE ? 'TLE' : hasRE ? 'RE' : hasWA ? 'WA' : 'AC';

      setSubmissionsMap(prev => {
        const list = prev[currentContest] || [];
        const newList = list.map(s => s.id === subId ? { ...s, status: finalStatus, testCases: [...resultsArr].sort((a, b) => a.id - b.id) } : s);
        saveSubmissions(currentContest, newList);
        return { ...prev, [currentContest]: newList };
      });
      showStatus('success', 'すべてのテストケースの実行が完了しました！');

    } catch (error) { showStatus('error', String(error)); }
    finally { setIsProcessing(false); }
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
                        <Play size={16} className="text-gray-400 group-hover:text-blue-600" />
                      </span>

                      {/* ↓ ここに最終更新日時を追加！ ↓ */}
                      <span className="text-xs text-gray-400 flex items-center gap-1">
                        <Clock size={14} />
                        {formatTimestamp(contest.updated_at)}
                      </span>
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
    <div className="min-h-screen flex flex-col bg-gray-50 text-gray-800 font-sans">
      <header className="bg-gray-900 text-white p-3 shadow flex justify-between items-center flex-none">
        <div className="flex items-center gap-4">
          <button onClick={() => setCurrentContest(null)} className="hover:bg-gray-700 p-2 rounded"><ArrowLeft size={20} /></button>
          <h1 className="text-lg font-bold flex items-center gap-2"><Code2 size={20} />{currentContest}</h1>
        </div>
        <button
          disabled={isProcessing || !currentContest}
          onClick={openSettings}
          className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg flex items-center gap-2 font-bold transition-colors disabled:opacity-50"
        >
          <Settings size={18} /> コンテスト設定・ケース生成
        </button>
      </header>

      <div className="bg-white border-b border-gray-200 px-6 flex gap-1 pt-3 flex-none">
        {/* ★ コード提出に戻る時に setVisData(null) を追加して閉じるようにしました */}
        <button onClick={() => { setActiveTab('submit'); setVisDataSynced(null); }} className={`px-4 py-2 rounded-t-lg font-bold border-t border-l border-r ${activeTab === 'submit' ? 'bg-white text-blue-600 border-gray-200 -mb-px' : 'bg-gray-100 text-gray-500 border-transparent hover:bg-gray-200'}`}>コード提出</button>
        <button onClick={() => { setActiveTab('submissions'); setSelectedSubId(null); setDetailTab('results'); }} className={`px-4 py-2 rounded-t-lg font-bold border-t border-l border-r flex items-center gap-1 ${activeTab === 'submissions' ? 'bg-white text-blue-600 border-gray-200 -mb-px' : 'bg-gray-100 text-gray-500 border-transparent hover:bg-gray-200'}`}><LayoutList size={18} /> 実行結果</button>
        <button onClick={() => setActiveTab('stats')} className={`px-4 py-2 rounded-t-lg font-bold border-t border-l border-r flex items-center gap-1 ${activeTab === 'stats' ? 'bg-white text-blue-600 border-gray-200 -mb-px' : 'bg-gray-100 text-gray-500 border-transparent hover:bg-gray-200'}`}><BarChart2 size={18} /> 統計 {selectedForStats.size > 0 && <span className="ml-auto bg-blue-100 text-blue-700 py-0.5 px-2 rounded-full text-xs">{selectedForStats.size}</span>}</button>
      </div>

      {/* 画面を左右に分割するメインエリア */}
      <main className="flex-1 flex flex-row overflow-hidden w-full">

        {/* 左側エリア（提出結果・エディタ）— 独立スクロール */}
        <div className={`flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-4 ${visData ? '' : 'max-w-7xl mx-auto w-full'}`}>
          {activeTab === 'submit' && (
            <div className="bg-white border border-gray-300 rounded-lg shadow-sm flex flex-col h-[calc(100vh-140px)] min-h-[500px]">
              <div className="p-3 border-b border-gray-200 flex gap-4 items-center bg-gray-50 rounded-t-lg overflow-x-auto">
                <select value={language} onChange={(e) => {
                  const lang = e.target.value;
                  setLanguage(lang);
                  // コードが初期状態に近ければテンプレートに切り替える
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
                <button disabled={isProcessing} onClick={handleSubmit} className="ml-auto bg-blue-600 hover:bg-blue-700 text-white font-bold py-1.5 px-6 rounded shadow flex items-center gap-2 disabled:opacity-50 transition-all whitespace-nowrap">
                  {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} fill="currentColor" />}
                  コンパイルして実行
                </button>
              </div>
              <div className="flex-1 relative">
                <Editor height="100%" language={language === 'python' ? 'python' : language === 'rust' ? 'rust' : 'cpp'} theme="vs-light" value={code} onChange={(v) => setCode(v || '')} options={{ fontSize: 14, minimap: { enabled: false } }} />
                {isProcessing && <div className="absolute inset-0 bg-white/50 backdrop-blur-sm z-10 flex items-center justify-center"><Loader2 size={48} className="animate-spin text-blue-600" /></div>}
              </div>
            </div>
          )}

          {activeTab === 'submissions' && (
            <div className="bg-white border border-gray-300 rounded-lg shadow-sm p-6 min-h-[500px]">
              {!selectedSubId && (
                <>
                  <h2 className="text-2xl font-bold flex items-center gap-2 mb-6 border-b pb-4"><LayoutList className="text-blue-500" /> 提出一覧</h2>
                  {sortedSubmissions.length === 0 ? (
                    <p className="text-gray-500 text-center py-10">まだ提出がありません。</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse whitespace-nowrap">
                        <thead>
                          <tr className="bg-gray-100 border-b-2 border-gray-300 text-sm select-none">
                            <th className="p-3 font-bold w-40 cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => handleSubmissionSort('timestamp')}>提出日時 {submissionSort.key === 'timestamp' && (submissionSort.order === 'asc' ? '↑' : '↓')}</th>
                            <th className="p-3 font-bold">コード名</th>
                            <th className="p-3 font-bold text-right cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => handleSubmissionSort('totalScore')}>得点 {submissionSort.key === 'totalScore' && (submissionSort.order === 'asc' ? '↑' : '↓')}</th>
                            <th className="p-3 font-bold text-right cursor-pointer hover:bg-gray-200 transition-colors text-blue-700" onClick={() => handleSubmissionSort('totalRelScore')}>相対スコア {submissionSort.key === 'totalRelScore' && (submissionSort.order === 'asc' ? '↑' : '↓')}</th>
                            <th className="p-3 font-bold text-right cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => handleSubmissionSort('codeLength')}>コード長 {submissionSort.key === 'codeLength' && (submissionSort.order === 'asc' ? '↑' : '↓')}</th>
                            <th className="p-3 font-bold text-right cursor-pointer hover:bg-gray-200 transition-colors" onClick={() => handleSubmissionSort('execTime')}>Max Time {submissionSort.key === 'execTime' && (submissionSort.order === 'asc' ? '↑' : '↓')}</th>
                            <th className="p-3 font-bold text-center">メモリ</th>
                            <th className="p-3 font-bold text-center w-28">結果</th>
                            <th className="p-3 font-bold text-center w-24">操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedSubmissions.map((sub: any) => (
                            <tr key={sub.id} className="border-b hover:bg-gray-50 transition-colors">
                              <td className="p-3 text-sm text-gray-600">{sub.time}</td>
                              <td className="p-3">
                                <div className="flex items-center gap-2 group">
                                  <input type="text" value={sub.name} onChange={(e) => updateSubName(sub.id, e.target.value)} className="border-b border-transparent hover:border-gray-300 focus:border-blue-500 focus:outline-none bg-transparent px-1 w-full max-w-[150px]" />
                                  <Edit2 size={12} className="text-gray-400 opacity-0 group-hover:opacity-100" />
                                </div>
                              </td>
                              <td className="p-3 font-mono text-right font-bold text-blue-600">{sub.totalScore.toLocaleString()}</td>
                              <td className="p-3 font-mono text-right font-bold text-blue-600">{sub.totalRelScore.toLocaleString()}</td>
                              <td className="p-3 font-mono text-right text-sm">{sub.codeLength} B</td>
                              <td className="p-3 font-mono text-right text-sm">{sub.execTime.toFixed(3)} s</td>
                              <td className="p-3 text-center text-sm text-gray-500">{sub.memory}</td>
                              <td className="p-3 text-center">{getStatusBadge(sub.status)}</td>
                              <td className="p-3 flex items-center justify-center gap-2">
                                <button onClick={() => { setSelectedSubId(sub.id); setDetailTab('results'); }} className="text-blue-500 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded text-sm font-bold flex items-center">詳細</button>
                                <button onClick={(e) => handleDeleteSubmission(e, sub.id)} className="text-gray-400 hover:text-red-500 p-1 rounded hover:bg-red-50 transition-colors" title="削除"><Trash2 size={16} /></button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

              {selectedSubId && selectedSub && (
                <div className="animate-in fade-in slide-in-from-right-4 duration-200">
                  <div className="flex flex-wrap justify-between items-center mb-6 border-b pb-4 gap-4">
                    <div>
                      <button onClick={() => { setSelectedSubId(null); setDetailTab('results'); }} className="text-gray-500 hover:text-gray-800 flex items-center gap-1 text-sm font-bold mb-2"><ArrowLeft size={16} /> 一覧へ戻る</button>
                      <h2 className="text-2xl font-bold flex items-center gap-2"><Trophy className="text-yellow-500" /> {selectedSub.name} の結果</h2>
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
                        <p className="text-sm text-gray-500 font-bold mb-1">Total Score</p>
                        <p className="text-3xl font-mono font-bold text-blue-600 leading-none">{selectedSub.totalScore.toLocaleString()}</p>
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
                    <div className="overflow-x-auto">
                      {(() => {
                        const sortedCases = [...(selectedSub.testCases || [])].sort((a, b) => {
                          let valA = a[testCaseSort.key as keyof typeof a];
                          let valB = b[testCaseSort.key as keyof typeof b];

                          // 相対スコアでのソート対応
                          if (testCaseSort.key === 'relScore') {
                            valA = calcRelativeScore(a.score, bestScores[a.id]);
                            valB = calcRelativeScore(b.score, bestScores[b.id]);
                          }

                          if (valA < valB) return testCaseSort.order === 'asc' ? -1 : 1;
                          if (valA > valB) return testCaseSort.order === 'asc' ? 1 : -1;
                          return 0;
                        });

                        return (
                          <table className="w-full text-left border-collapse whitespace-nowrap">
                            <thead>
                              <tr className="bg-gray-100 border-b-2 border-gray-300">
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
                              {sortedCases.map((r) => {
                                const relScore = calcRelativeScore(r.score, bestScores[r.id]);
                                return (
                                  <React.Fragment key={r.id}>
                                    <tr className={`border-b hover:bg-gray-50 ${visData && r.id === Number(visData.input.match(/Case: (\d+)/)?.[1] || r.id) ? 'bg-blue-50' : ''}`}>
                                      <td className="p-3 font-mono text-center text-gray-500">{String(r.id).padStart(4, '0')}</td>
                                      <td className="p-3 text-center">{getStatusBadge(r.status)}</td>
                                      <td className="p-3 font-mono text-right text-gray-600">{r.time.toFixed(3)}s</td>
                                      <td className="p-3 font-mono text-right font-bold">{r.score > 0 ? r.score.toLocaleString() : '-'}</td>
                                      <td className="p-3 font-mono text-right font-bold text-blue-600">{relScore.toLocaleString()}</td>
                                      <td className="p-3 text-center">
                                        <button onClick={() => openVisualizer(r.id, selectedSub.id)} className="text-gray-600 hover:text-blue-600 p-1 hover:bg-blue-50 rounded transition-colors" title="アプリ内でビジュアライザを再生"><Play size={18} /></button>
                                      </td>
                                      <td className="p-3 text-center">
                                        <button
                                          onClick={() => toggleCaseIO(r.id, selectedSub.id)}
                                          className={`px-2 py-1 rounded text-xs font-bold transition-colors ${expandedCaseIO[r.id] !== undefined ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                                          title="入出力を表示"
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
                                        <td colSpan={8} className="px-4 py-3">
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
                        );
                      })()}
                    </div>
                  ) : (
                    <div className="h-[500px] border border-gray-300 rounded-lg overflow-hidden relative">
                      <div className="absolute top-2 right-3 z-10">
                        <CopyButton text={selectedSub.code} className="shadow-sm" />
                      </div>
                      <Editor language={selectedSub.language === 'python' ? 'python' : selectedSub.language === 'rust' ? 'rust' : 'cpp'} theme="vs-light" value={selectedSub.code} options={{ readOnly: true, minimap: { enabled: false }, fontSize: 14 }} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ★ ここから追加：統計タブ */}
          {activeTab === 'stats' && (
            <div className="flex-1 overflow-auto p-6 bg-gray-50 flex flex-col gap-6 relative">
              {/* ポイントホバー用フローティングツールチップ */}
              {statsPointTooltip && (
                <div
                  className="fixed z-50 pointer-events-none"
                  style={{ left: statsPointTooltip.px + 12, top: statsPointTooltip.py - 10 }}
                >
                  <ChartPointTooltip score={statsPointTooltip.score} id={statsPointTooltip.id} label={statsPointTooltip.label} />
                </div>
              )}

              <h2 className="text-2xl font-bold flex items-center gap-2 text-gray-800">
                <BarChart2 size={28} className="text-blue-600" /> 統計・分析
              </h2>

              {/* ── 提出選択パネル ── */}
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="p-3 bg-gray-50 border-b flex items-center justify-between">
                  <h3 className="font-bold text-gray-700">比較する提出を選択</h3>
                  {selectedForStats.size > 0 && (
                    <button onClick={() => setSelectedForStats(new Set())} className="text-xs text-gray-400 hover:text-red-500 transition-colors">すべて解除</button>
                  )}
                </div>
                {submissions.length === 0 ? (
                  <p className="text-sm text-gray-400 p-4">提出がありません</p>
                ) : (
                  <table className="w-full text-left text-sm whitespace-nowrap">
                    <thead>
                      <tr className="bg-gray-50 border-b text-gray-500 text-xs">
                        <th className="py-2 px-3 font-normal w-8"></th>
                        <th className="py-2 px-3 font-normal w-36">提出日時</th>
                        <th className="py-2 px-3 font-normal">コード名</th>
                        <th className="py-2 px-3 font-normal text-right">得点</th>
                        <th className="py-2 px-3 font-normal text-right">相対スコア</th>
                        <th className="py-2 px-3 font-normal text-center">結果</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedSubmissions.map((sub: any) => {
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
                            <td className="py-2 px-3 text-gray-500">{sub.time}</td>
                            <td className="py-2 px-3 font-bold" style={checked ? { color } : { color: '#374151' }}>{sub.name}</td>
                            <td className="py-2 px-3 font-mono text-right text-blue-600 font-bold">{sub.totalScore.toLocaleString()}</td>
                            <td className="py-2 px-3 font-mono text-right text-blue-600 font-bold">{sub.totalRelScore.toLocaleString()}</td>
                            <td className="py-2 px-3 text-center">{getStatusBadge(sub.status)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
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

                return (
                  <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                    {/* 左カラム：フィルタ設定 */}
                    <div className="lg:col-span-1 bg-white p-4 rounded-xl shadow-sm border border-gray-200 h-fit space-y-4">
                      <h3 className="font-bold text-gray-700 border-b pb-2">X軸・フィルター</h3>
                      {/* X軸モード */}
                      <div>
                        <label className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1 block">X軸</label>
                        <div className="flex gap-1">
                          <button
                            onClick={() => setStatsXAxisMode('auto')}
                            className={`flex-1 py-1.5 text-xs font-bold rounded transition-colors ${statsXAxisMode === 'auto' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                          >変数</button>
                          <button
                            onClick={() => setStatsXAxisMode('seed')}
                            className={`flex-1 py-1.5 text-xs font-bold rounded transition-colors ${statsXAxisMode === 'seed' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                          >seed</button>
                        </div>
                      </div>
                      {statsXAxisMode === 'auto' && (
                        <>
                          <h3 className="font-bold text-gray-700 border-b pb-2 pt-1">変数フィルター</h3>
                          {activeVars.length === 0 ? <p className="text-sm text-gray-500">変数がありません</p> : activeVars.map(v => (
                            <div key={v} className="space-y-1">
                              <label className="text-sm font-bold text-gray-600">{v}</label>
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
                        </>
                      )}
                    </div>

                    {/* 右カラム：グラフ + サマリー */}
                    <div className="lg:col-span-3 space-y-6">
                      {statsXAxisMode === 'seed' ? (() => {
                        // ── seed 折れ線グラフ ──
                        const onHover = (info: HoverInfo) => { setStatsPointTooltip(info); hoveredPointRef.current = { id: info.id }; };
                        const onLeave = () => setStatsPointTooltip(null);
                        const onClickPoint = (id: number, subId: string) => {
                          setCurrentVisSubId(subId);
                          openVisualizer(id, subId);
                        };
                        const hoveredId = statsPointTooltip?.id ?? null;

                        let globalYMin = Infinity, globalYMax = -Infinity;
                        const lineSeries: SeedLineSeries[] = compareSubmissions.map(sub => {
                          const data = (sub.testCases ?? []).map((tc: any) => {
                            if (tc.score < globalYMin) globalYMin = tc.score;
                            if (tc.score > globalYMax) globalYMax = tc.score;
                            return { id: tc.id, score: tc.score };
                          });
                          return { subId: sub.id, subName: sub.name, data };
                        });
                        if (globalYMin === Infinity) { globalYMin = 0; globalYMax = 100; }
                        const yPadding = (globalYMax - globalYMin) * 0.05;
                        const yDomain: [number, number] = [globalYMin - yPadding, globalYMax + yPadding];

                        return (
                          <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                            <div className="flex justify-between items-end mb-3 border-b pb-2 flex-wrap gap-2">
                              <h3 className="font-bold text-lg text-gray-800">
                                seed vs 絶対スコア
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
                      })() : activeVars.map(v => {
                        let uniqueValues = new Set<number>();
                        let globalYMin = Infinity, globalYMax = -Infinity;

                        const plotData = compareSubmissions.map(sub => {
                          const subData: ScatterPoint[] = [];
                          const boxMap: Record<number, { score: number; id: number }[]> = {};
                          sub.testCases?.forEach((tc: any) => {
                            const val = testcaseVars[tc.id]?.[v];
                            if (val === undefined) return;
                            const fMin = varFilters[v]?.min, fMax = varFilters[v]?.max;
                            if (typeof fMin === 'number' && val < fMin) return;
                            if (typeof fMax === 'number' && val > fMax) return;
                            uniqueValues.add(val);
                            subData.push({ x: val, y: tc.score, id: tc.id });
                            if (!boxMap[val]) boxMap[val] = [];
                            boxMap[val].push({ score: tc.score, id: tc.id });
                            if (tc.score < globalYMin) globalYMin = tc.score;
                            if (tc.score > globalYMax) globalYMax = tc.score;
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
                                  const fMin = varFilters[v]?.min, fMax = varFilters[v]?.max;
                                  if (typeof fMin === 'number' && val < fMin) return false;
                                  if (typeof fMax === 'number' && val > fMax) return false;
                                  return true;
                                })
                                .map((tc: any) => ({ score: tc.score, id: tc.id })) || [];
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
                            <div key={v} className="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                              <div className="flex justify-between items-end mb-3 border-b pb-2 flex-wrap gap-2">
                                <h3 className="font-bold text-lg text-gray-800">
                                  {v} vs 絶対スコア
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
                          <div key={v} className="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                            <div className="flex justify-between items-end mb-3 border-b pb-2 flex-wrap gap-2">
                              <h3 className="font-bold text-lg text-gray-800">{v} vs 絶対スコア</h3>
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
                      <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                        <h3 className="font-bold text-lg text-gray-800 mb-1 border-b pb-2">提出サマリー（全テストケース）</h3>
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
                                const entries = sub.testCases?.map(tc => ({ score: tc.score, id: tc.id })) || [];
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
          )}
          {/* ★ ここまで追加 */}
        </div>

        {/* ★ ここから追加：設定＆ケース生成モーダル */}
        {isSettingsOpen && editingConfig && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-8 backdrop-blur-sm">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
              <div className="p-4 bg-gray-100 border-b flex justify-between items-center">
                <h3 className="text-lg font-bold flex items-center gap-2 text-gray-800">
                  <Settings size={20} className="text-gray-600" />
                  {currentContest} の設定
                </h3>
              </div>

              <div className="p-6 space-y-6">
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
                    disabled={isProcessing}
                    className="px-4 py-2 bg-white hover:bg-gray-50 text-gray-700 rounded-lg border border-gray-300 shadow-sm transition-colors flex items-center gap-2 font-bold disabled:opacity-50"
                  >
                    <Folder size={18} className="text-blue-500" />
                    {isProcessing ? '展開中...' : 'ZIPファイルを参照して展開...'}
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
        {/* ★ ここまで追加 */}

        {/* 右側エリア（ビジュアライザ）— 独立スクロール不可・高さ固定 */}
        {visData && (
          <div className="w-[50%] min-w-[440px] max-w-[60%] border-l border-gray-300 bg-white flex flex-col overflow-hidden shadow-[-8px_0_16px_-8px_rgba(0,0,0,0.08)] z-10">
            <div className="p-3 bg-gray-50 border-b flex justify-between items-center flex-none">
              <div className="flex items-center gap-4">
                <h3 className="font-bold flex items-center gap-2 text-gray-800"><Eye size={18} className="text-blue-500" /> Visualizer</h3>
                {visData.web_url && (
                  <button onClick={handleOpenWebVis} className="text-blue-600 hover:text-blue-800 text-sm font-bold flex items-center gap-1 underline transition-colors" title="外部ブラウザで開く">
                    <ExternalLink size={14} /> ブラウザで開く
                  </button>
                )}
              </div>
              <button onClick={() => { setVisDataSynced(null); setCurrentVisId(null); }} className="px-4 py-1.5 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-md font-bold transition-colors text-sm">閉じる</button>
            </div>
            <div className="flex-1 overflow-hidden relative">
              {visData.local_url ? (
                <iframe ref={visIframeRef} src={visData.local_url} className="absolute inset-0 w-full h-full border-0" />
              ) : (
                <iframe ref={visIframeRef} srcDoc={visData.html} className="absolute inset-0 w-full h-full border-0" />
              )}
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