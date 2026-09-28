package com.balloondog.agent.service;

import android.app.job.JobParameters;
import android.app.job.JobService;

import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;

/**
 * JobScheduler 兜底保活。
 *
 * <p>与 {@link WatchdogReceiver} 的 AlarmManager 形成两条独立链路：
 * 厂商 ROM 经常对其中一条做限制，两条都断的概率低得多。
 * 任务本身不做任何业务，只确认守护还在跑。
 */
public class AgentJobService extends JobService {

    @Override
    public boolean onStartJob(JobParameters params) {
        AgentStore store = new AgentStore(this);
        if (!store.isAgentEnabled()) {
            return false;
        }
        if (!AgentService.isRunning()) {
            EventLog.warn("兜底任务发现守护服务未在运行，正在拉起");
            AgentService.start(this);
        }
        // 没有异步工作，立即结束
        return false;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        // 返回 true 让系统在被中断后重排，保活任务不希望被丢掉
        return true;
    }
}
