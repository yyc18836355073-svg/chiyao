import React from 'react';

// 补打卡 Modal
export function DayDetailModal({ dayNum, dateLabel, logs, onToggle, onClose }) {
  const dayLog = logs[dayNum] || { morning: false, evening: false };
  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-3xl p-5 w-full max-w-xs space-y-4 shadow-2xl">
        <div className="flex justify-between items-center border-b border-slate-700 pb-2.5">
          <h3 className="font-bold text-sky-400">
            第 {dayNum} 天打卡记录 ({dateLabel})
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 text-sm font-bold">
            ✕
          </button>
        </div>

        <div className="space-y-3">
          <div className="flex justify-between items-center bg-slate-900/60 p-3 rounded-2xl border border-slate-700">
            <div>
              <span className="text-sm font-medium text-slate-200">🌅 早餐服药</span>
              <span className="text-xs block text-slate-400">
                {dayLog.morningTime ? `完成于 ${dayLog.morningTime}` : '未完成'}
              </span>
            </div>
            <button
              onClick={() => onToggle(dayNum, 'morning')}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                dayLog.morning
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              {dayLog.morning ? '已完成 (撤销)' : '标记完成'}
            </button>
          </div>

          <div className="flex justify-between items-center bg-slate-900/60 p-3 rounded-2xl border border-slate-700">
            <div>
              <span className="text-sm font-medium text-slate-200">🌙 晚餐服药</span>
              <span className="text-xs block text-slate-400">
                {dayLog.eveningTime ? `完成于 ${dayLog.eveningTime}` : '未完成'}
              </span>
            </div>
            <button
              onClick={() => onToggle(dayNum, 'evening')}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                dayLog.evening
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              {dayLog.evening ? '已完成 (撤销)' : '标记完成'}
            </button>
          </div>
        </div>

        <button
          onClick={onClose}
          className="w-full py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold rounded-xl"
        >
          关闭
        </button>
      </div>
    </div>
  );
}

// 紧急解除安全锁警告 Modal
export function UnlockModal({ onClose, onConfirm }) {
  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-800 border border-amber-600/80 rounded-3xl p-5 w-full max-w-xs space-y-4 text-center shadow-2xl">
        <div className="text-3xl">⚠️</div>
        <h3 className="font-bold text-amber-400">解除间隔安全锁警告</h3>
        <p className="text-xs text-slate-300 text-left leading-relaxed">
          提前服用第二次抗生素可能导致血药浓度过高或剧烈消化道反应。请仅在跨时区、作息倒班等极特殊情况下解除。
        </p>
        <div className="flex gap-2 pt-2">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 bg-slate-700 text-slate-300 text-xs font-bold rounded-xl"
          >
            保持锁定
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2.5 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold rounded-xl"
          >
            强制解锁
          </button>
        </div>
      </div>
    </div>
  );
}

// 设置与说明 Modal
export function SettingsModal({
  startDate, onStartDateChange,
  dailySchedule, onDailyChange, dailySaved,
  onSaveDaily, onCancelDaily,
  onRequestNotification, onResetAll, onClose,
}) {
  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-3xl p-5 w-full max-w-sm space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center border-b border-slate-700 pb-2.5">
          <h3 className="font-bold text-sky-400">应用设置与疗程说明</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 text-sm font-bold">
            ✕
          </button>
        </div>

        <div className="space-y-1.5 text-xs text-left">
          <label className="font-semibold text-slate-300">疗程开始日期：</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => onStartDateChange(e.target.value)}
            className="w-full bg-slate-900 border border-slate-700 rounded-xl p-2 text-slate-100 font-mono"
          />
        </div>

        <div className="bg-slate-900/80 p-3 rounded-2xl border border-slate-700/80 text-left space-y-2.5">
          <div className="flex items-center justify-between">
            <p className="font-bold text-sky-300 text-xs">⏰ 每日定时吃药提醒</p>
            <span className={`text-[10px] px-2 py-0.5 rounded-full ${
              dailySaved === 'saved' ? 'bg-emerald-500/20 text-emerald-300'
              : dailySaved === 'error' ? 'bg-rose-500/20 text-rose-300'
              : dailySaved === 'saving' ? 'bg-sky-500/20 text-sky-300'
              : 'bg-slate-700/60 text-slate-400'
            }`}>
              {dailySaved === 'saved' ? '✓ 已保存' : dailySaved === 'error' ? '保存失败' : dailySaved === 'saving' ? '保存中…' : '随时可修改'}
            </span>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-1">
              <span className="text-slate-300">🌅 早餐提醒</span>
              <input
                type="time"
                value={dailySchedule.morning || ''}
                onChange={(e) => onDailyChange({ ...dailySchedule, morning: e.target.value })}
                className="flex-1 bg-slate-800 border border-slate-600 rounded-lg p-1.5 text-slate-100 font-mono text-center"
              />
            </div>
            <div className="flex items-center gap-2 flex-1">
              <span className="text-slate-300">🌙 晚餐提醒</span>
              <input
                type="time"
                value={dailySchedule.evening || ''}
                onChange={(e) => onDailyChange({ ...dailySchedule, evening: e.target.value })}
                className="flex-1 bg-slate-800 border border-slate-600 rounded-lg p-1.5 text-slate-100 font-mono text-center"
              />
            </div>
          </div>

          <p className="text-[10px] text-slate-400 leading-relaxed">
            到点自动推送通知提醒服药（需已开启推送）。留空表示关闭该时段提醒。
          </p>

          <div className="flex gap-2 pt-1">
            <button
              onClick={onSaveDaily}
              disabled={dailySaved === 'saving'}
              className="flex-1 py-2 bg-sky-700 hover:bg-sky-600 disabled:opacity-50 text-white text-xs font-bold rounded-xl"
            >
              保存提醒时间
            </button>
            <button
              onClick={onCancelDaily}
              disabled={dailySaved === 'saving'}
              className="px-3 py-2 bg-rose-950/60 hover:bg-rose-900 disabled:opacity-50 text-rose-300 border border-rose-700/40 text-xs font-bold rounded-xl"
            >
              关闭
            </button>
          </div>
        </div>

        <div className="bg-slate-900/80 p-3 rounded-2xl border border-slate-700/80 text-left text-xs space-y-2 text-slate-300 leading-relaxed">
          <p className="font-bold text-sky-300">💡 标准四联疗法提示：</p>
          <p>1. <strong>饭前药 (PPI+铋剂)：</strong> 饭前30分钟服用，抑酸并保护胃黏膜屏障。</p>
          <p>2. <strong>饭后药 (2种抗生素)：</strong> 饭后15-30分钟服用，缓冲消化并降低胃肠刺激。</p>
          <p>3. <strong>严禁饮酒：</strong> 服药期间及停药一周内严禁接触任何酒精。</p>
        </div>

        <div className="space-y-2 pt-2">
          <button
            onClick={onRequestNotification}
            className="w-full py-2.5 bg-sky-700 hover:bg-sky-600 text-white text-xs font-bold rounded-xl"
          >
            重新申请系统提醒权限
          </button>
          <button
            onClick={onResetAll}
            className="w-full py-2.5 bg-rose-950/80 hover:bg-rose-900 text-rose-300 border border-rose-700/50 text-xs font-bold rounded-xl"
          >
            重置所有打卡数据
          </button>
        </div>

        <button
          onClick={onClose}
          className="w-full py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold rounded-xl"
        >
          返回主界面
        </button>
      </div>
    </div>
  );
}