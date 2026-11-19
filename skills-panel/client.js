window.__ModuleLoader__.load({
  id: '@local/skills-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'skillsPanel';
    const LIST = '/skills-panel/list';
    const FILE = '/skills-panel/file';
    const TOGGLE = '/skills-panel/toggle';
    const PANEL_ID = 'skills';

    // -----------------------------------------------------------------------
    // Copy
    // -----------------------------------------------------------------------

    const zh = {
      panel: '技能',
      title: '技能',
      subtitle: '查看本机与随包的技能，用开关控制模型和 / 菜单是否还能调用它们。',
      refresh: '刷新',
      refreshing: '读取中…',
      loading: '正在读取技能目录…',
      loadFailed: '读取失败：{message}',
      authFailed: '页面认证失效，请刷新页面后重试。',
      offline: '无法连接 Host，请确认页面仍在连接中。',
      retry: '重试',
      empty: '还没有发现任何技能。',
      emptyHint: '把技能放到下面的目录即可被扫描到，无需重启：',
      stats: '{total} 个技能 · {manageable} 个可开关 · {enabled} 个已启用',
      incomplete: '目录发现不完整，列表可能缺少部分技能。',
      'group.project': '项目',
      'group.user': '用户与自定义',
      'group.bundled': '随包提供（只读）',
      'group.other': '其他',
      'badge.project': '项目',
      'badge.user': '用户',
      'badge.custom': '自定义',
      'badge.bundled': '随包',
      'badge.runtime': '运行时',
      'badge.readonly': '只读',
      'badge.mixed': '部分',
      switchLabel: '启用 {name}',
      switchOn: '已启用',
      switchOff: '已停用',
      readonlyHint: '随包提供的技能不能在这里关闭。',
      showFile: '查看 SKILL.md',
      hideFile: '收起',
      fileFailed: '读取 SKILL.md 失败：{message}',
      'error.toggle': '切换失败：{message}',
      'error.auth': '页面认证失效，请刷新页面后重试。',
      noPath: '无预览',
      userDir: '用户技能',
      projectDir: '项目技能',
    };

    const en = {
      panel: 'Skills',
      title: 'Skills',
      subtitle: 'Inspect the skills on this machine and in packaged bundles, and switch what the model and the / menu can call.',
      refresh: 'Refresh',
      refreshing: 'Reading…',
      loading: 'Reading the skill catalog…',
      loadFailed: 'Could not read: {message}',
      authFailed: 'The page session is not authenticated. Reload the page and try again.',
      offline: 'Cannot reach the Host. Check that this page is still connected.',
      retry: 'Retry',
      empty: 'No skills were found.',
      emptyHint: 'Drop a skill into one of these directories; no restart is needed:',
      stats: '{total} skills · {manageable} switchable · {enabled} on',
      incomplete: 'Discovery was incomplete, so some skills may be missing.',
      'group.project': 'Project',
      'group.user': 'User and custom',
      'group.bundled': 'Packaged (read-only)',
      'group.other': 'Other',
      'badge.project': 'Project',
      'badge.user': 'User',
      'badge.custom': 'Custom',
      'badge.bundled': 'Packaged',
      'badge.runtime': 'Runtime',
      'badge.readonly': 'Read-only',
      'badge.mixed': 'Partial',
      switchLabel: 'Enable {name}',
      switchOn: 'On',
      switchOff: 'Off',
      readonlyHint: 'A packaged skill cannot be switched off here.',
      showFile: 'View SKILL.md',
      hideFile: 'Hide',
      fileFailed: 'Could not read SKILL.md: {message}',
      'error.toggle': 'Could not switch: {message}',
      'error.auth': 'The page session is not authenticated. Reload the page and retry.',
      noPath: 'No file',
      userDir: 'User skills',
      projectDir: 'Project skills',
    };

    // -----------------------------------------------------------------------
    // Data access
    // -----------------------------------------------------------------------

    function request(url, options) {
      const init = Object.assign({ credentials: 'same-origin', headers: { accept: 'application/json' } }, options);
      return fetch(url, init).then((response) => {
        if (response.status === 401 || response.status === 403) {
          const error = new Error('unauthorized');
          error.code = 'unauthorized';
          throw error;
        }
        return response.text().then((text) => {
          let body = {};
          try {
            body = text.length > 0 ? JSON.parse(text) : {};
          } catch {
            body = {};
          }
          if (!response.ok) {
            const error = new Error(body && typeof body.error === 'string' ? body.error : 'HTTP ' + response.status);
            error.code = 'http';
            throw error;
          }
          return body;
        });
      });
    }

    // -----------------------------------------------------------------------
    // Presentational parts
    // -----------------------------------------------------------------------

    const CSS = [
      '.dsw-skills{display:flex;flex-direction:column;gap:14px;height:100%;min-height:0;overflow:auto;',
      'padding:18px 22px 32px;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;}',
      '.dsw-skills *{box-sizing:border-box;}',
      '.dsw-skills-head{display:flex;align-items:flex-start;gap:12px;}',
      '.dsw-skills-headtext{flex:1;min-width:0;}',
      '.dsw-skills-title{font-size:15px;font-weight:600;letter-spacing:.01em;}',
      '.dsw-skills-sub{margin-top:3px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);}',
      '.dsw-skills-button{appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;',
      'padding:4px 10px;cursor:pointer;flex:none;}',
      '.dsw-skills-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);}',
      '.dsw-skills-button:disabled{opacity:.55;cursor:default;}',
      '.dsw-skills-stats{font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dsw-skills-group{display:flex;flex-direction:column;gap:8px;}',
      '.dsw-skills-grouphead{font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;',
      'color:var(--dsw-alias-label-secondary);padding-left:2px;}',
      '.dsw-skills-row{display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px;padding:10px 12px;',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}',
      '.dsw-skills-rowmain{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:3px;}',
      '.dsw-skills-namerow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.dsw-skills-name{font-size:13px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}',
      '.dsw-skills-badge{font-size:10px;line-height:1.6;padding:0 6px;border-radius:999px;',
      'border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);',
      'background:var(--dsw-alias-bg-layer-2);white-space:nowrap;}',
      '.dsw-skills-desc{font-size:12px;color:var(--dsw-alias-label-secondary);',
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
      '.dsw-skills-path{font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.85;white-space:nowrap;',
      'overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}',
      '.dsw-skills-side{display:flex;align-items:center;gap:8px;flex:none;}',
      '.dsw-skills-state{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.dsw-skills-toggle{position:relative;width:34px;height:20px;border-radius:999px;border:0;padding:0;flex:none;',
      'background:var(--dsw-alias-bg-layer-2);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1);',
      'cursor:pointer;transition:background .15s ease;}',
      '.dsw-skills-toggle[aria-checked="true"]{background:var(--dsw-alias-brand-primary);box-shadow:none;}',
      '.dsw-skills-toggle:disabled{cursor:default;opacity:.45;}',
      '.dsw-skills-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;',
      'background:#fff;transition:transform .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.25);}',
      '.dsw-skills-toggle[aria-checked="true"] .dsw-skills-knob{transform:translateX(14px);}',
      '.dsw-skills-notice{display:flex;flex-direction:column;gap:6px;border:1px dashed var(--dsw-alias-border-l1);',
      'border-radius:10px;padding:14px;color:var(--dsw-alias-label-secondary);font-size:12px;}',
      '.dsw-skills-warn{font-size:11px;color:var(--dsw-alias-state-warn-primary);}',
      '.dsw-skills-error{font-size:11px;color:var(--dsw-alias-state-error-primary);}',
      '.dsw-skills-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);padding:2px 6px;border-radius:6px;',
      'align-self:flex-start;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dsw-skills-pre{margin:2px 0 0;width:100%;max-height:320px;overflow:auto;white-space:pre-wrap;',
      'word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;',
      'line-height:1.55;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:8px;padding:10px 12px;}',
    ].join('');

    function Style() {
      return h('style', null, CSS);
    }

    function replace(template, values) {
      return template.replace(/\{(\w+)\}/g, (match, key) =>
        values && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
      );
    }

    function badgeClass(badge) {
      return 'dsw-skills-badge';
    }

    function Row(props) {
      const { skill, t, pending, onToggle, onToggleFile, open, preview } = props;
      const source = skill.source === 'project-dsh' || skill.source === 'project-agents'
        ? 'badge.project'
        : skill.source === 'user-dsh' || skill.source === 'user-agents'
          ? 'badge.user'
          : skill.source === 'custom'
            ? 'badge.custom'
            : skill.source === 'bundled'
              ? 'badge.bundled'
              : skill.source === 'runtime'
                ? 'badge.runtime'
                : null;
      const busy = pending === skill.path;
      const state = skill.enabled ? 'switchOn' : 'switchOff';
      return h(
        'div',
        { className: 'dsw-skills-row' },
        h(
          'div',
          { className: 'dsw-skills-rowmain' },
          h(
            'div',
            { className: 'dsw-skills-namerow' },
            h('span', { className: 'dsw-skills-name' }, skill.name),
            source ? h('span', { className: badgeClass() }, t(source)) : null,
            skill.manageable ? null : h('span', { className: 'dsw-skills-badge' }, t('badge.readonly')),
            skill.mixed ? h('span', { className: 'dsw-skills-badge' }, t('badge.mixed')) : null,
          ),
          skill.description ? h('div', { className: 'dsw-skills-desc' }, skill.description) : null,
          skill.path ? h('div', { className: 'dsw-skills-path', title: skill.path }, skill.path) : null,
        ),
        h(
          'div',
          { className: 'dsw-skills-side' },
          skill.path
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsw-skills-button',
                  onClick: () => onToggleFile(skill),
                },
                open ? t('hideFile') : t('showFile'),
              )
            : h('span', { className: 'dsw-skills-state' }, t('noPath')),
          h('span', { className: 'dsw-skills-state' }, t(state)),
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              'aria-checked': skill.enabled ? 'true' : 'false',
              'aria-label': replace(t('switchLabel'), { name: skill.name }),
              title: skill.manageable ? undefined : t('readonlyHint'),
              className: 'dsw-skills-toggle',
              disabled: !skill.manageable || busy,
              onClick: () => onToggle(skill, !skill.enabled),
            },
            h('span', { className: 'dsw-skills-knob' }),
          ),
        ),
        open
          ? preview && preview.phase === 'ready'
            ? h('pre', { className: 'dsw-skills-pre' }, preview.content)
            : h(
                'div',
                { className: 'dsw-skills-pre' },
                preview && preview.phase === 'error'
                  ? h('span', { className: 'dsw-skills-error' }, replace(t('fileFailed'), { message: preview.message }))
                  : t('loading'),
              )
          : null,
      );
    }

    // -----------------------------------------------------------------------
    // Panel
    // -----------------------------------------------------------------------

    function SkillsPage(props) {
      const t = props && typeof props.t === 'function' ? props.t : (key) => key;
      const [phase, setPhase] = React.useState('loading');
      const [data, setData] = React.useState(null);
      const [failure, setFailure] = React.useState(null);
      const [attempt, setAttempt] = React.useState(0);
      const [busy, setBusy] = React.useState(false);
      const [pending, setPending] = React.useState(null);
      const [openPath, setOpenPath] = React.useState(null);
      const [preview, setPreview] = React.useState(null);
      const [notice, setNotice] = React.useState(null);

      React.useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        setBusy(true);
        request(LIST + '?attempt=' + attempt, { signal: controller.signal }).then(
          (value) => {
            if (cancelled) return;
            setData(value);
            setFailure(null);
            setPhase('ready');
            setBusy(false);
          },
          (error) => {
            if (cancelled || (error && error.name === 'AbortError')) return;
            setFailure(error);
            setPhase('error');
            setBusy(false);
          },
        );
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [attempt]);

      const toggle = (skill, next) => {
        setPending(skill.path);
        setNotice(null);
        request(TOGGLE, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ path: skill.path, enabled: next }),
        }).then(
          () => {
            setData((previous) =>
              previous === null
                ? previous
                : Object.assign({}, previous, {
                    skills: previous.skills.map((entry) =>
                      entry.path === skill.path
                        ? Object.assign({}, entry, {
                            enabled: next,
                            mixed: false,
                            modelInvocable: next,
                            userInvocable: next,
                          })
                        : entry,
                    ),
                  }),
            );
            setPending(null);
            // The provider rescans from its file watcher; re-read after it settles.
            setTimeout(() => setAttempt((value) => value + 1), 600);
          },
          (error) => {
            setPending(null);
            setNotice(
              error && error.code === 'unauthorized'
                ? t('error.auth')
                : replace(t('error.toggle'), { message: error && error.message ? error.message : String(error) }),
            );
          },
        );
      };

      const toggleFile = (skill) => {
        if (openPath === skill.path) {
          setOpenPath(null);
          setPreview(null);
          return;
        }
        setOpenPath(skill.path);
        setPreview({ phase: 'loading' });
        request(FILE + '?path=' + encodeURIComponent(skill.path)).then(
          (value) => setPreview({ phase: 'ready', content: value.content }),
          (error) =>
            setPreview({
              phase: 'error',
              message: error && error.message ? error.message : String(error),
            }),
        );
      };

      const head = h(
        'div',
        { className: 'dsw-skills-head' },
        h(
          'div',
          { className: 'dsw-skills-headtext' },
          h('div', { className: 'dsw-skills-title' }, t('title')),
          h('div', { className: 'dsw-skills-sub' }, t('subtitle')),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsw-skills-button',
            disabled: busy,
            onClick: () => setAttempt((value) => value + 1),
          },
          busy ? t('refreshing') : t('refresh'),
        ),
      );

      if (phase === 'loading' && data === null) {
        return h('div', { className: 'dsw-skills' }, h(Style), head, h('div', { className: 'dsw-skills-notice' }, t('loading')));
      }

      if (phase === 'error' || data === null) {
        const code = failure ? failure.code : undefined;
        const message =
          code === 'unauthorized'
            ? t('authFailed')
            : code === undefined
              ? t('offline')
              : replace(t('loadFailed'), { message: failure && failure.message ? failure.message : String(code) });
        return h(
          'div',
          { className: 'dsw-skills' },
          h(Style),
          head,
          h(
            'div',
            { className: 'dsw-skills-notice' },
            h('span', { className: 'dsw-skills-error' }, message),
            h(
              'button',
              { type: 'button', className: 'dsw-skills-button', onClick: () => setAttempt((value) => value + 1) },
              t('retry'),
            ),
          ),
        );
      }

      const skills = Array.isArray(data.skills) ? data.skills : [];
      const groups = ['project', 'user', 'bundled', 'other'];
      const counts = data.counts ?? { total: skills.length, manageable: 0, enabled: 0 };

      return h(
        'div',
        { className: 'dsw-skills' },
        h(Style),
        head,
        h('div', { className: 'dsw-skills-stats' }, replace(t('stats'), counts)),
        data.complete === false ? h('div', { className: 'dsw-skills-warn' }, t('incomplete')) : null,
        notice ? h('div', { className: 'dsw-skills-error' }, notice) : null,
        skills.length === 0
          ? h(
              'div',
              { className: 'dsw-skills-notice' },
              h('span', null, t('empty')),
              h('span', null, t('emptyHint')),
              data.dirs && data.dirs.user ? h('code', { className: 'dsw-skills-code' }, data.dirs.user) : null,
              data.dirs && data.dirs.project ? h('code', { className: 'dsw-skills-code' }, data.dirs.project) : null,
            )
          : groups.map((group) => {
              const members = skills.filter((skill) => (skill.group ?? 'other') === group);
              if (members.length === 0) return null;
              return h(
                'div',
                { className: 'dsw-skills-group', key: group },
                h('div', { className: 'dsw-skills-grouphead' }, t('group.' + group)),
                members.map((skill) =>
                  h(Row, {
                    key: skill.name,
                    skill,
                    t,
                    pending,
                    open: openPath === skill.path,
                    preview: openPath === skill.path ? preview : null,
                    onToggle: toggle,
                    onToggleFile: toggleFile,
                  }),
                ),
              );
            }),
      );
    }

    // -----------------------------------------------------------------------
    // Sidebar glyph
    // -----------------------------------------------------------------------

    function SkillsPanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M10 3.5l1.9 4.6L16.5 10l-4.6 1.9L10 16.5 8.1 11.9 3.5 10l4.6-1.9L10 3.5z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M17.8 14.2l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z',
          fill: 'currentColor',
        }),
      );
    }

    // -----------------------------------------------------------------------
    // Client plugin
    // -----------------------------------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'skills-panel.copy');
        const t = ctx.locale.bind(NS);

        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 5,
                  label: () => t('panel'),
                  locale: NS,
                },
                SkillsPanelIcon,
              )),
          'skills-panel.nav',
        );

        ctx.effect(
          () =>
            ctx.slots.inject('main', () =>
              ctx.slots.register(
                {
                  name: 'main',
                  key: PANEL_ID,
                  locale: NS,
                  inject: () => ({ t }),
                },
                SkillsPage,
              )),
          'skills-panel.page',
        );
      },
    };
  },
});
