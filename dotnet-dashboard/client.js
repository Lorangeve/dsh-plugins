window.__ModuleLoader__.load({
  id: '@local/dotnet-dashboard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ID = '@local/dotnet-dashboard';
    const NS = 'dotnetDashboard';
    const ROUTE = '/dotnet/status';

    // ---------------------------------------------------------------------
    // Copy
    // ---------------------------------------------------------------------

    const zh = {
      title: '.NET 仪表盘',
      description: '查看 .NET SDK、NuGet 源与项目建议',
      refresh: '刷新',
      refreshing: '读取中…',
      updated: '更新于 {time}',
      retry: '重试',
      copy: '复制',
      copied: '已复制',
      loading: '正在读取 .NET 环境…',
      loadFailed: '读取失败：{message}',
      authFailed: '无法通过浏览器认证，请刷新页面后重试。',
      offline: '无法连接 Host，请确认页面与 Harness 的连接正常。',
      'section.sdk': 'SDK 与运行时',
      'section.nuget': 'NuGet 源',
      'section.project': '项目概览',
      'section.guidance': '指导建议',
      'badge.ready': '正常',
      'badge.attention': '需处理',
      'badge.missing': '不可用',
      'sdk.version': 'CLI 版本',
      'sdk.path': '可执行文件',
      'sdk.sdks': '已安装 SDK',
      'sdk.runtimes': '运行时',
      'sdk.moreRuntimes': '展开 {count} 个运行时',
      'sdk.lessRuntimes': '收起运行时',
      'nuget.none': '没有配置任何包源',
      'nuget.cache': '全局包缓存',
      'nuget.cacheValue': '{count} 个包',
      'nuget.configs': '配置文件',
      'nuget.configCount': '{count} 个',
      'nuget.credentials': '凭据',
      'nuget.credentialsValue': '已配置',
      'project.name': '主项目',
      'project.path': '位置',
      'project.framework': '目标框架',
      'project.deps': '依赖',
      'project.packages': '{count} 个包引用',
      'project.refs': '{count} 个项目引用',
      'project.solutions': '解决方案',
      'project.solutionCount': '{count} 个',
      'project.tests': '测试项目',
      'project.testCount': '{count} 个',
      'project.none': '当前工作区没有 .NET 项目',
      'value.unknown': '未知',
      'value.none': '无',
      'guidance.empty': '没有需要处理的事项，保持现状即可。',
      'item.dotnet.missing.title': '未找到 dotnet CLI',
      'item.dotnet.missing.detail': '在 PATH 中找不到 dotnet 可执行文件，无法读取 SDK 与 NuGet 信息。先安装 SDK 再刷新。',
      'item.dotnet.ready.title': '已安装 .NET SDK {version}',
      'item.dotnet.ready.detail': '共 {count} 个 SDK 可用，dotnet CLI 响应正常。',
      'item.dotnet.global-json-mismatch.title': 'global.json 锁定的 SDK {version} 未安装',
      'item.dotnet.global-json-mismatch.detail': '{project} 通过 global.json 固定了 SDK 版本，当前机器缺少该版本，restore 与 build 会失败。',
      'item.nuget.no-source.title': '没有可用的 NuGet 源',
      'item.nuget.no-source.detail': '用户级与仓库级配置中都没有包源，restore 无法下载任何包。',
      'item.nuget.ready.title': '{enabled}/{total} 个 NuGet 源已启用',
      'item.nuget.ready.detail': '已解析工作区的 NuGet 配置，包源可用。',
      'item.nuget.no-nuget-org.title': '缺少 nuget.org 源',
      'item.nuget.no-nuget-org.detail': '当前启用的源里没有公共 Gallery，公共包将无法还原。',
      'item.nuget.disabled-source.title': '源 {names} 被禁用',
      'item.nuget.disabled-source.detail': '被禁用的源仍保留在配置中，需要时用 dotnet nuget enable source 打开。',
      'item.project.none.title': '当前工作区没有 .NET 项目',
      'item.project.none.detail': '在 {cwd} 中没有找到 .csproj 或 .sln。可以用下面的命令创建项目骨架。',
      'item.project.ready.title': '已识别 {project}',
      'item.project.ready.detail': '目标框架 {framework}，包含 {packages} 个包引用。',
      'item.project.framework-old.title': '目标框架 {framework} 已不是受支持版本',
      'item.project.framework-old.detail': '建议升级到 net8.0 或更高版本，以获得官方支持与 NuGet 审计。',
      'item.project.nullable-off.title': '{project} 未启用可空引用类型',
      'item.project.nullable-off.detail': '开启 <Nullable>enable</Nullable> 可以在编译期捕获空引用风险。',
      'item.project.restore-missing.title': '尚未还原依赖',
      'item.project.restore-missing.detail': '缺少 obj/project.assets.json，先执行 restore 再构建。',
      'item.project.restore-stale.title': '依赖可能已过期',
      'item.project.restore-stale.detail': '项目文件比 project.assets.json 更新，建议重新还原。',
      'item.project.no-tests.title': '还没有测试项目',
      'item.project.no-tests.detail': '为 {project} 添加测试项目，并把 dotnet test 接入 CI。',
      'item.project.no-central-packages.title': '管理 {count} 个包引用但没有集中版本管理',
      'item.project.no-central-packages.detail': '启用 Directory.Packages.props 可以统一版本，避免多项目之间的版本漂移。',
      'item.project.warnings-not-errors.title': '警告不会阻断构建',
      'item.project.warnings-not-errors.detail': '在 CI 中使用 -warnaserror，把警告当作错误处理。',
      'item.project.no-editorconfig.title': '缺少 .editorconfig',
      'item.project.no-editorconfig.detail': '共享代码风格与分析器规则，减少格式噪音。',
      'item.project.audit.title': '运行一次依赖审计',
      'item.project.audit.detail': '检查 {project} 的已知漏洞与过期包。',
      'item.project.build.title': '常用命令',
      'item.project.build.detail': '构建、测试与格式检查的标准入口。',
    };

    const en = {
      title: '.NET dashboard',
      description: 'SDK, NuGet sources, and project advice',
      refresh: 'Refresh',
      refreshing: 'Reading…',
      updated: 'Updated {time}',
      retry: 'Retry',
      copy: 'Copy',
      copied: 'Copied',
      loading: 'Reading the .NET environment…',
      loadFailed: 'Could not read: {message}',
      authFailed: 'The browser session was not accepted. Reload the page and try again.',
      offline: 'Cannot reach the Host. Check that this page is still connected.',
      'section.sdk': 'SDK and runtimes',
      'section.nuget': 'NuGet sources',
      'section.project': 'Project',
      'section.guidance': 'Guidance',
      'badge.ready': 'Ready',
      'badge.attention': 'Needs work',
      'badge.missing': 'Unavailable',
      'sdk.version': 'CLI version',
      'sdk.path': 'Executable',
      'sdk.sdks': 'Installed SDKs',
      'sdk.runtimes': 'Runtimes',
      'sdk.moreRuntimes': 'Show {count} runtimes',
      'sdk.lessRuntimes': 'Hide runtimes',
      'nuget.none': 'No package source is configured',
      'nuget.cache': 'Global packages',
      'nuget.cacheValue': '{count} packages',
      'nuget.configs': 'Config files',
      'nuget.configCount': '{count}',
      'nuget.credentials': 'Credentials',
      'nuget.credentialsValue': 'configured',
      'project.name': 'Primary project',
      'project.path': 'Location',
      'project.framework': 'Target framework',
      'project.deps': 'Dependencies',
      'project.packages': '{count} package references',
      'project.refs': '{count} project references',
      'project.solutions': 'Solutions',
      'project.solutionCount': '{count}',
      'project.tests': 'Test projects',
      'project.testCount': '{count}',
      'project.none': 'No .NET project in this workspace',
      'value.unknown': 'unknown',
      'value.none': 'none',
      'guidance.empty': 'Nothing needs attention here.',
      'item.dotnet.missing.title': 'The dotnet CLI was not found',
      'item.dotnet.missing.detail': 'No dotnet executable is on PATH, so the SDK and NuGet inventory cannot be read. Install an SDK, then refresh.',
      'item.dotnet.ready.title': '.NET SDK {version} is installed',
      'item.dotnet.ready.detail': '{count} SDKs are available and the CLI answered normally.',
      'item.dotnet.global-json-mismatch.title': 'global.json pins SDK {version}, which is not installed',
      'item.dotnet.global-json-mismatch.detail': '{project} selects an SDK version through global.json; restore and build fail on this machine until it is installed.',
      'item.nuget.no-source.title': 'No NuGet source is available',
      'item.nuget.no-source.detail': 'Neither the user nor the repository configuration lists a package source, so restore cannot download anything.',
      'item.nuget.ready.title': '{enabled}/{total} NuGet sources enabled',
      'item.nuget.ready.detail': 'The NuGet configuration for this workspace was resolved and its sources are usable.',
      'item.nuget.no-nuget-org.title': 'nuget.org is missing',
      'item.nuget.no-nuget-org.detail': 'No enabled source serves the public gallery, so public packages cannot be restored.',
      'item.nuget.disabled-source.title': '{names} is disabled',
      'item.nuget.disabled-source.detail': 'A disabled source stays in the configuration; enable it with dotnet nuget enable source when needed.',
      'item.project.none.title': 'No .NET project in this workspace',
      'item.project.none.detail': 'No .csproj or .sln was found under {cwd}. Use the commands below to create a project skeleton.',
      'item.project.ready.title': '{project} detected',
      'item.project.ready.detail': 'Target framework {framework} with {packages} package references.',
      'item.project.framework-old.title': 'Target framework {framework} is out of support',
      'item.project.framework-old.detail': 'Upgrade to net8.0 or later for official support and NuGet auditing.',
      'item.project.nullable-off.title': '{project} does not enable nullable reference types',
      'item.project.nullable-off.detail': 'Setting <Nullable>enable</Nullable> catches null-reference risk at compile time.',
      'item.project.restore-missing.title': 'Dependencies are not restored',
      'item.project.restore-missing.detail': 'obj/project.assets.json is missing; restore before building.',
      'item.project.restore-stale.title': 'Dependencies may be stale',
      'item.project.restore-stale.detail': 'The project file is newer than project.assets.json; restore again.',
      'item.project.no-tests.title': 'No test project yet',
      'item.project.no-tests.detail': 'Add a test project for {project} and run dotnet test in CI.',
      'item.project.no-central-packages.title': '{count} package references without central version management',
      'item.project.no-central-packages.detail': 'Directory.Packages.props keeps versions in one place and prevents drift between projects.',
      'item.project.warnings-not-errors.title': 'Warnings do not fail the build',
      'item.project.warnings-not-errors.detail': 'Pass -warnaserror in CI to treat warnings as errors.',
      'item.project.no-editorconfig.title': '.editorconfig is missing',
      'item.project.no-editorconfig.detail': 'Share code style and analyzer rules to keep formatting noise down.',
      'item.project.audit.title': 'Run a dependency audit',
      'item.project.audit.detail': 'Check {project} for known vulnerabilities and outdated packages.',
      'item.project.build.title': 'Everyday commands',
      'item.project.build.detail': 'The standard entry points for build, test, and format checks.',
    };

    // ---------------------------------------------------------------------
    // Data access
    // ---------------------------------------------------------------------

    function statusUrl(sessionId, refresh) {
      const query = [];
      if (typeof sessionId === 'string' && sessionId.length > 0) query.push('sessionId=' + encodeURIComponent(sessionId));
      if (refresh) query.push('refresh=1');
      return ROUTE + (query.length > 0 ? '?' + query.join('&') : '');
    }

    function readStatus(sessionId, refresh, signal) {
      const url = statusUrl(sessionId, refresh);
      return fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        signal,
      })
        .then((response) => {
          if (response.status === 401 || response.status === 403) {
            const error = new Error('unauthorized');
            error.code = 'unauthorized';
            throw error;
          }
          if (!response.ok) {
            return response.json().then(
              (body) => {
                const error = new Error(body && typeof body.error === 'string' ? body.error : 'HTTP ' + response.status);
                error.code = 'http';
                throw error;
              },
              () => {
                const error = new Error('HTTP ' + response.status);
                error.code = 'http';
                throw error;
              },
            );
          }
          return response.json();
        })
        .catch((error) => {
          if (error && typeof error === 'object') {
            error.url = url;
            if (!error.detail) error.detail = (error.name || 'Error') + ': ' + (error.message || '');
          }
          throw error;
        });
    }

    // ---------------------------------------------------------------------
    // Presentation helpers
    // ---------------------------------------------------------------------

    const CSS = [
      '.dsw-dotnet{display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;overflow:auto;',
      'padding:14px 14px 28px;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;}',
      '.dsw-dotnet *{box-sizing:border-box;}',
      '.dsw-dotnet-head{display:flex;align-items:flex-start;gap:8px;position:sticky;top:-14px;z-index:2;',
      'padding:14px 0 10px;margin:-14px 0 0;background:var(--dsw-alias-bg-base);}',
      '.dsw-dotnet-headtext{flex:1;min-width:0;}',
      '.dsw-dotnet-title{font-size:15px;font-weight:600;letter-spacing:.01em;}',
      '.dsw-dotnet-sub{margin-top:2px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dsw-dotnet-button{appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;',
      'padding:4px 10px;cursor:pointer;}',
      '.dsw-dotnet-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);}',
      '.dsw-dotnet-button:disabled{opacity:.55;cursor:default;}',
      '.dsw-dotnet-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1);padding:10px 12px;}',
      '.dsw-dotnet-cardhead{display:flex;align-items:center;gap:8px;margin-bottom:8px;}',
      '.dsw-dotnet-cardtitle{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;',
      'color:var(--dsw-alias-label-secondary);flex:1;min-width:0;}',
      '.dsw-dotnet-badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);',
      'color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.dsw-dotnet-badge.is-ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor;}',
      '.dsw-dotnet-badge.is-warn{color:var(--dsw-alias-state-warn-primary);border-color:currentColor;}',
      '.dsw-dotnet-badge.is-error{color:var(--dsw-alias-state-error-primary);border-color:currentColor;}',
      '.dsw-dotnet-row{display:flex;gap:10px;align-items:baseline;padding:2px 0;}',
      '.dsw-dotnet-label{flex:0 0 86px;font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.dsw-dotnet-value{flex:1;min-width:0;overflow-wrap:anywhere;}',
      '.dsw-dotnet-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;',
      'color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.dsw-dotnet-chips{display:flex;flex-wrap:wrap;gap:4px;align-items:center;}',
      '.dsw-dotnet-chip{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;',
      'padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);',
      'white-space:nowrap;}',
      '.dsw-dotnet-list{display:flex;flex-direction:column;gap:6px;}',
      '.dsw-dotnet-source{display:flex;gap:8px;align-items:flex-start;}',
      '.dsw-dotnet-sourcemain{flex:1;min-width:0;}',
      '.dsw-dotnet-sourcename{font-weight:500;}',
      '.dsw-dotnet-dot{flex:0 0 7px;width:7px;height:7px;border-radius:50%;margin-top:6px;background:var(--dsw-alias-state-idle-primary);}',
      '.dsw-dotnet-dot.is-ok{background:var(--dsw-alias-state-success-primary);}',
      '.dsw-dotnet-dot.is-warn{background:var(--dsw-alias-state-warn-primary);}',
      '.dsw-dotnet-dot.is-error{background:var(--dsw-alias-state-error-primary);}',
      '.dsw-dotnet-dot.is-info{background:var(--dsw-alias-state-idle-primary);}',
      '.dsw-dotnet-item{display:flex;gap:8px;align-items:flex-start;padding:7px 0;',
      'border-top:1px solid var(--dsw-alias-border-l1);}',
      '.dsw-dotnet-item:first-child{border-top:none;padding-top:0;}',
      '.dsw-dotnet-itemmain{flex:1;min-width:0;}',
      '.dsw-dotnet-itemtitle{font-weight:500;}',
      '.dsw-dotnet-itemdetail{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:1px;}',
      '.dsw-dotnet-cmds{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}',
      '.dsw-dotnet-cmd{appearance:none;display:inline-flex;align-items:center;gap:6px;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);',
      'color:var(--dsw-alias-label-primary);padding:3px 7px;font:inherit;max-width:100%;}',
      '.dsw-dotnet-cmd code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;',
      'white-space:pre-wrap;overflow-wrap:anywhere;text-align:left;}',
      '.dsw-dotnet-cmd span{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.dsw-dotnet-cmd:hover{background:var(--dsw-alias-bg-layer-1);}',
      '.dsw-dotnet-notice{border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;',
      'padding:10px 12px;font-size:12px;color:var(--dsw-alias-state-error-primary);',
      'background:var(--dsw-alias-bg-layer-1);}',
      '.dsw-dotnet-empty{font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.dsw-dotnet-footer{font-size:11px;color:var(--dsw-alias-label-secondary);padding-top:2px;overflow-wrap:anywhere;}',
    ].join('');

    function Style() {
      return h('style', { dangerouslySetInnerHTML: { __html: CSS } });
    }

    function Badge(props) {
      return h('span', { className: 'dsw-dotnet-badge is-' + props.level }, props.label);
    }

    function Row(props) {
      return h(
        'div',
        { className: 'dsw-dotnet-row' },
        h('span', { className: 'dsw-dotnet-label' }, props.label),
        h('span', { className: 'dsw-dotnet-value', title: props.title }, props.children),
      );
    }

    function Command(props) {
      const [copied, setCopied] = React.useState(false);
      const onCopy = () => {
        const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
        if (!clipboard || typeof clipboard.writeText !== 'function') return;
        const finish = () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        };
        clipboard.writeText(props.text).then(finish, () => undefined);
      };
      return h(
        'button',
        { type: 'button', className: 'dsw-dotnet-cmd', onClick: onCopy, title: props.text },
        h('code', null, props.text),
        h('span', null, copied ? props.copiedLabel : props.copyLabel),
      );
    }

    function formatTime(value) {
      try {
        return new Date(value).toLocaleTimeString();
      } catch (error) {
        return String(value);
      }
    }

    function levelRank(level) {
      if (level === 'error') return 0;
      if (level === 'warn') return 1;
      if (level === 'info') return 2;
      return 3;
    }

    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }

    // ---------------------------------------------------------------------
    // Panel
    // ---------------------------------------------------------------------

    function Panel(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const sessionId = props.sessionId;
      const [phase, setPhase] = React.useState('loading');
      const [snapshot, setSnapshot] = React.useState(null);
      const [failure, setFailure] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [showRuntimes, setShowRuntimes] = React.useState(false);
      const [attempt, setAttempt] = React.useState(0);

      React.useEffect(() => {
        const controller = new AbortController();
        setBusy(true);
        readStatus(sessionId, attempt > 0, controller.signal).then(
          (value) => {
            if (controller.signal.aborted) return;
            setSnapshot(value);
            setFailure(null);
            setPhase('ready');
            setBusy(false);
          },
          (error) => {
            if (controller.signal.aborted) return;
            setFailure(error);
            setPhase('error');
            setBusy(false);
          },
        );
        return () => controller.abort();
      }, [sessionId, attempt]);

      const refresh = () => setAttempt((value) => value + 1);

      if (phase === 'loading') {
        return h('div', { className: 'dsw-dotnet' }, h(Style), h('div', { className: 'dsw-dotnet-empty' }, t('loading')));
      }

      if (phase === 'error' || snapshot === null) {
        const code = failure ? failure.code : undefined;
        const message =
          code === 'unauthorized'
            ? t('authFailed')
            : code === undefined
              ? t('offline')
              : t('loadFailed', { message: failure && failure.message ? failure.message : String(code) });
        return h(
          'div',
          { className: 'dsw-dotnet' },
          h(Style),
          h(
            'div',
            { className: 'dsw-dotnet-head' },
            h('div', { className: 'dsw-dotnet-headtext' }, h('div', { className: 'dsw-dotnet-title' }, t('title'))),
          ),
          h('div', { className: 'dsw-dotnet-notice' }, message),
          failure && failure.detail
            ? h('div', { className: 'dsw-dotnet-mono' }, (failure.url || '') + ' — ' + failure.detail)
            : null,
          h('div', null, h('button', { type: 'button', className: 'dsw-dotnet-button', onClick: refresh }, t('retry'))),
        );
      }

      const dotnet = snapshot.dotnet || {};
      const nuget = snapshot.nuget || {};
      const project = snapshot.project || {};
      const guidance = asArray(snapshot.guidance);
      const ordered = guidance.slice().sort((left, right) => levelRank(left.level) - levelRank(right.level));
      const attention = guidance.some((item) => item.level === 'error' || item.level === 'warn');
      const sdks = asArray(dotnet.sdks);
      const runtimes = asArray(dotnet.runtimes);
      const sources = asArray(nuget.sources);
      const configFiles = asArray(nuget.configFiles);
      const solutions = asArray(project.solutions);
      const primary = project.primary || null;

      const header = h(
        'div',
        { className: 'dsw-dotnet-head' },
        h(
          'div',
          { className: 'dsw-dotnet-headtext' },
          h('div', { className: 'dsw-dotnet-title' }, t('title')),
          h('div', { className: 'dsw-dotnet-sub' }, t('updated', { time: formatTime(snapshot.generatedAt) })),
        ),
        h(
          'button',
          { type: 'button', className: 'dsw-dotnet-button', disabled: busy, onClick: refresh },
          busy ? t('refreshing') : t('refresh'),
        ),
      );

      const sdkCard = h(
        'section',
        { className: 'dsw-dotnet-card' },
        h(
          'div',
          { className: 'dsw-dotnet-cardhead' },
          h('span', { className: 'dsw-dotnet-cardtitle' }, t('section.sdk')),
          h(Badge, {
            level: dotnet.found ? 'ok' : 'error',
            label: dotnet.found ? t('badge.ready') : t('badge.missing'),
          }),
        ),
        h(Row, { label: t('sdk.version') }, h('span', { className: 'dsw-dotnet-mono' }, dotnet.version || t('value.unknown'))),
        h(
          Row,
          { label: t('sdk.path'), title: dotnet.executable || undefined },
          h('span', { className: 'dsw-dotnet-mono' }, dotnet.executable || t('value.none')),
        ),
        sdks.length > 0
          ? h(
            Row,
            { label: t('sdk.sdks') },
            h(
              'span',
              { className: 'dsw-dotnet-chips' },
              sdks.slice().reverse().map((sdk) =>
                h('span', { className: 'dsw-dotnet-chip', key: sdk.version, title: sdk.path }, sdk.version)),
            ),
          )
          : null,
        runtimes.length > 0
          ? h(
            'div',
            null,
            h(
              Row,
              { label: t('sdk.runtimes') },
              h(
                'span',
                { className: 'dsw-dotnet-chips' },
                h('span', { className: 'dsw-dotnet-chip' }, String(runtimes.length)),
                h(
                  'button',
                  { type: 'button', className: 'dsw-dotnet-button', onClick: () => setShowRuntimes((value) => !value) },
                  showRuntimes ? t('sdk.lessRuntimes') : t('sdk.moreRuntimes', { count: runtimes.length }),
                ),
              ),
            ),
            showRuntimes
              ? h(
                'div',
                { className: 'dsw-dotnet-list', style: { marginTop: '6px' } },
                runtimes.map((runtime) =>
                  h(
                    'div',
                    { className: 'dsw-dotnet-source', key: runtime.name + runtime.version },
                    h('span', { className: 'dsw-dotnet-dot is-info' }),
                    h(
                      'div',
                      { className: 'dsw-dotnet-sourcemain' },
                      h('div', { className: 'dsw-dotnet-mono' }, runtime.name + ' ' + runtime.version),
                    ),
                  )),
              )
              : null,
          )
          : null,
      );

      const nugetCard = h(
        'section',
        { className: 'dsw-dotnet-card' },
        h(
          'div',
          { className: 'dsw-dotnet-cardhead' },
          h('span', { className: 'dsw-dotnet-cardtitle' }, t('section.nuget')),
          h(Badge, {
            level: sources.some((source) => source.enabled) ? 'ok' : 'warn',
            label: sources.some((source) => source.enabled) ? t('badge.ready') : t('badge.attention'),
          }),
        ),
        sources.length === 0
          ? h('div', { className: 'dsw-dotnet-empty' }, t('nuget.none'))
          : h(
            'div',
            { className: 'dsw-dotnet-list' },
            sources.map((source, index) =>
              h(
                'div',
                { className: 'dsw-dotnet-source', key: String(index) + ':' + source.name },
                h('span', { className: 'dsw-dotnet-dot ' + (source.enabled ? 'is-ok' : 'is-warn') }),
                h(
                  'div',
                  { className: 'dsw-dotnet-sourcemain' },
                  h('div', { className: 'dsw-dotnet-sourcename' }, source.name),
                  h('div', { className: 'dsw-dotnet-mono', title: source.configFile || undefined }, source.url),
                ),
              )),
          ),
        h(
          'div',
          { style: { marginTop: '8px' } },
          h(
            Row,
            { label: t('nuget.cache') },
            typeof nuget.cachedPackageCount === 'number'
              ? h('span', null, t('nuget.cacheValue', { count: nuget.cachedPackageCount }))
              : h('span', { className: 'dsw-dotnet-mono', title: nuget.globalPackagesFolder || undefined },
                nuget.globalPackagesFolder || t('value.unknown')),
          ),
          configFiles.length > 0
            ? h(
              Row,
              { label: t('nuget.configs'), title: configFiles.join('\n') },
              h('span', { className: 'dsw-dotnet-mono' }, t('nuget.configCount', { count: configFiles.length })),
            )
            : null,
          nuget.hasCredentials
            ? h(Row, { label: t('nuget.credentials') }, h('span', null, t('nuget.credentialsValue')))
            : null,
        ),
      );

      const projectCard = h(
        'section',
        { className: 'dsw-dotnet-card' },
        h(
          'div',
          { className: 'dsw-dotnet-cardhead' },
          h('span', { className: 'dsw-dotnet-cardtitle' }, t('section.project')),
          primary ? h(Badge, { level: 'ok', label: t('badge.ready') }) : null,
        ),
        primary === null
          ? h(
            'div',
            null,
            h('div', { className: 'dsw-dotnet-empty' }, t('project.none')),
            h('div', { className: 'dsw-dotnet-mono', style: { marginTop: '4px' } }, project.cwd || ''),
          )
          : h(
            'div',
            null,
            h(Row, { label: t('project.name') }, h('span', null, primary.name)),
            h(
              Row,
              { label: t('project.path'), title: primary.path },
              h('span', { className: 'dsw-dotnet-mono' }, primary.path),
            ),
            h(
              Row,
              { label: t('project.framework') },
              h(
                'span',
                { className: 'dsw-dotnet-chips' },
                asArray(primary.targetFrameworks).map((framework) =>
                  h('span', { className: 'dsw-dotnet-chip', key: framework }, framework)),
              ),
            ),
            h(
              Row,
              { label: t('project.deps') },
              h(
                'span',
                null,
                t('project.packages', { count: asArray(primary.packageReferences).length }) +
                  ' · ' +
                  t('project.refs', { count: primary.projectReferences || 0 }),
              ),
            ),
            solutions.length > 0
              ? h(
                Row,
                { label: t('project.solutions'), title: solutions.map((entry) => entry.path).join('\n') },
                h('span', null, t('project.solutionCount', { count: solutions.length })),
              )
              : null,
            h(
              Row,
              { label: t('project.tests') },
              h('span', null, t('project.testCount', { count: project.testProjects || 0 })),
            ),
          ),
      );

      const guidanceCard = h(
        'section',
        { className: 'dsw-dotnet-card' },
        h(
          'div',
          { className: 'dsw-dotnet-cardhead' },
          h('span', { className: 'dsw-dotnet-cardtitle' }, t('section.guidance')),
          h(Badge, {
            level: attention ? 'warn' : 'ok',
            label: attention ? t('badge.attention') : t('badge.ready'),
          }),
        ),
        ordered.length === 0
          ? h('div', { className: 'dsw-dotnet-empty' }, t('guidance.empty'))
          : h(
            'div',
            null,
            ordered.map((item) => {
              const titleKey = 'item.' + item.id + '.title';
              const detailKey = 'item.' + item.id + '.detail';
              const params = item.params || {};
              const detail = t(detailKey, params);
              const commands = asArray(item.commands);
              return h(
                'div',
                { className: 'dsw-dotnet-item', key: item.id },
                h('span', { className: 'dsw-dotnet-dot is-' + (item.level || 'info') }),
                h(
                  'div',
                  { className: 'dsw-dotnet-itemmain' },
                  h('div', { className: 'dsw-dotnet-itemtitle' }, t(titleKey, params)),
                  detail === detailKey ? null : h('div', { className: 'dsw-dotnet-itemdetail' }, detail),
                  commands.length > 0
                    ? h(
                      'div',
                      { className: 'dsw-dotnet-cmds' },
                      commands.map((command) =>
                        h(Command, {
                          key: command,
                          text: command,
                          copyLabel: t('copy'),
                          copiedLabel: t('copied'),
                        })),
                    )
                    : null,
                ),
              );
            }),
          ),
      );

      return h(
        'div',
        { className: 'dsw-dotnet' },
        h(Style),
        header,
        sdkCard,
        nugetCard,
        projectCard,
        guidanceCard,
        h('div', { className: 'dsw-dotnet-footer' }, snapshot.cwd || ''),
      );
    }

    // ---------------------------------------------------------------------
    // Client plugin
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'dotnet-dashboard.copy',
        );
        const t = ctx.locale.bind(NS);

        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: ID,
              kind: 'dotnet',
              title: () => t('title'),
              guide: [
                {
                  id: 'panel',
                  order: 30,
                  title: () => t('title'),
                  description: () => t('description'),
                },
              ],
            }),
          'dotnet-dashboard.type',
        );

        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: ID,
                  locale: NS,
                },
                Panel,
              )),
          'dotnet-dashboard.body',
        );
      },
    };
  },
});
