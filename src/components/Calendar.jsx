import React from 'react';

// 14 天打卡日历网格
export default function Calendar({ logs, currentDayNum, getDayDateLabel, onSelect }) {
  return (
    <section className="space-y-2.5">
      <div className="flex justify-between items-center text-xs">
        <h2 className="font-bold text-slate-200 flex items-center gap-1">
          <span>📅</span> 14 天打卡日历视图
        </h2>
        <span className="text-slate-400">点击日期可手动补打卡</span>
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {Array.from({ length: 14 }).map((_, idx) => {
          const dayNum = idx + 1;
          const dayLog = logs[dayNum] || { morning: false, evening: false };
          const isToday = dayNum === currentDayNum;

          return (
            <div
              key={dayNum}
              onClick={() => onSelect(dayNum)}
              className={`p-1.5 rounded-xl border text-center cursor-pointer transition-all active:scale-95 flex flex-col justify-between h-20 ${
                isToday
                  ? 'bg-slate-800 border-sky-500 shadow-md shadow-sky-950'
                  : 'bg-slate-800/60 border-slate-700/60 hover:bg-slate-800'
              }`}
            >
              <div className="text-[10px] text-slate-400 font-mono flex justify-between items-center">
                <span>D{dayNum}</span>
                <span>{getDayDateLabel(dayNum)}</span>
              </div>

              <div className="space-y-1 my-auto">
                <div className={`text-[10px] py-0.5 rounded font-medium flex items-center justify-center gap-0.5 ${
                  dayLog.morning
                    ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-600/40'
                    : 'bg-slate-900/60 text-slate-500'
                }`}>
                  <span>早</span>
                  <span>{dayLog.morning ? '✓' : '•'}</span>
                </div>

                <div className={`text-[10px] py-0.5 rounded font-medium flex items-center justify-center gap-0.5 ${
                  dayLog.evening
                    ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-600/40'
                    : 'bg-slate-900/60 text-slate-500'
                }`}>
                  <span>晚</span>
                  <span>{dayLog.evening ? '✓' : '•'}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}