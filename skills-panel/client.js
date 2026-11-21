/**
 * Client half of the Skills panel.
 *
 * One sidebar entry, two levels: the list groups every skill this profile can
 * reach, and a skill's own page shows its description, invocation contract and
 * SKILL.md. The rhythm deliberately copies the built-in Plugins panel — 20 px
 * page title, 960 px column, 48 px card icons, a breadcrumb back button and the
 * same section/facts primitives — so the two panels read as one product.
 *
 * Primitives are shared with the built-in client; if a build ever drops them the
 * panel falls back to local button/switch/icon stand-ins instead of failing to
 * load.
 */

window.__ModuleLoader__.load({
  id: '@local/skills-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    let primitives = {};
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') || {};
    } catch {
      primitives = {};
    }

    const NS = 'skillsPanel';
    const LIST = '/skills-panel/list';
    const FILE = '/skills-panel/file';
    const TOGGLE = '/skills-panel/toggle';
    const PANEL_ID = 'skills';

    const Button = primitives.Button || FallbackButton;
    const Switch = primitives.Switch || FallbackSwitch;
    const IconSkill = primitives.IconSkillOutlineRegular || null;
    const IconChevronDown = primitives.IconChevronDownOutlineRegular || null;
    const IconChevronRight = primitives.IconChevronRightOutlineRegular || null;
    const IconCopy = primitives.IconCopyOutlineRegular || null;

    // -----------------------------------------------------------------------
    // Copy
    // -----------------------------------------------------------------------

    const zh = {
      panel: '技能',
      title: '技能',
      subtitle: '查看本机与随包的技能；点开任意一项查看说明、调用方式与 SKILL.md。',
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
      'group.bundled': '随包提供',
      'group.other': '其他',
      'badge.project': '项目',
      'badge.user': '用户',
      'badge.custom': '自定义',
      'badge.bundled': '随包',
      'badge.runtime': '运行时',
      'badge.readonly': '只读',
      'badge.mixed': '部分启用',
      switchLabel: '启用 {name}',
      switchOn: '已启用',
      switchOff: '已停用',
      readonlyHint: '随包提供的技能由 DSH 携带，不能在这里关闭。',
      openDetail: '查看 {name}',
      backToList: '返回技能列表',
      crumb: '技能',
      sectionContract: '调用方式',
      'fact.source': '来源',
      'fact.model': '模型可调用',
      'fact.user': '斜杠菜单',
      'fact.manage': '文件可写',
      'fact.provider': '提供方',
      yes: '是',
      no: '否',
      sectionWhen: '何时使用',
      sectionFile: 'SKILL.md',
      copy: '复制',
      copied: '已复制',
      fileLoading: '正在读取 SKILL.md…',
      fileFailed: '读取 SKILL.md 失败：{message}',
      noPath: '没有可预览的指令文件',
      'error.toggle': '切换失败：{message}',
      'error.auth': '页面认证失效，请刷新页面后重试。',
      userDir: '用户技能',
      projectDir: '项目技能',
    };

    const en = {
      panel: 'Skills',
      title: 'Skills',
      subtitle: 'Inspect the skills this profile can reach. Open one for its description, invocation contract and SKILL.md.',
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
      'group.bundled': 'Packaged',
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
      readonlyHint: 'A packaged skill ships with DSH and cannot be switched off here.',
      openDetail: 'View {name}',
      backToList: 'Back to skills',
      crumb: 'Skills',
      sectionContract: 'Invocation',
      'fact.source': 'Source',
      'fact.model': 'Model can call it',
      'fact.user': 'Slash menu',
      'fact.manage': 'File is writable',
      'fact.provider': 'Provider',
      yes: 'Yes',
      no: 'No',
      sectionWhen: 'When to use it',
      sectionFile: 'SKILL.md',
      copy: 'Copy',
      copied: 'Copied',
      fileLoading: 'Reading SKILL.md…',
      fileFailed: 'Could not read SKILL.md: {message}',
      noPath: 'No instruction file to preview',
      'error.toggle': 'Could not switch: {message}',
      'error.auth': 'The page session is not authenticated. Reload the page and retry.',
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
    // Style — mirrors the built-in plugin page measurements
    // -----------------------------------------------------------------------

    const CSS = [
      '.sk-page{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;',
      'align-items:center;padding:0 clamp(20px,4vw,48px);color:var(--dsw-alias-label-primary);',
      'font-size:13px;line-height:1.5;}',
      '.sk-page *{box-sizing:border-box;}',
      '.sk-body{box-sizing:border-box;width:100%;max-width:960px;flex:1;min-height:0;overflow:auto;',
      'padding:0 0 48px;scroll-behavior:smooth;}',
      '.sk-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;',
      'gap:16px;padding-top:28px;}',
      '.sk-heading{min-width:0;max-width:100%;}',
      '.sk-title{margin:0;font-size:20px;font-weight:500;line-height:28px;}',
      '.sk-intro{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
      '.sk-toolbar{display:flex;align-items:center;gap:12px;flex:none;}',
      '.sk-stats{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}',
      '.sk-warn{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary);}',
      '.sk-error{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);}',
      '.sk-groups{display:flex;flex-direction:column;gap:28px;margin-top:24px;}',
      '.sk-group{display:flex;flex-direction:column;gap:8px;}',
      '.sk-groupTitle{display:flex;align-items:baseline;gap:8px;margin:0;font-size:14px;',
      'font-weight:500;line-height:22px;}',
      '.sk-groupCount{font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary);}',
      '.sk-cards{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;}',
      '.sk-card{position:relative;min-width:0;margin:0 -8px;border-radius:var(--dsw-radius-xl);}',
      '.sk-cardHead{display:flex;align-items:center;gap:8px;padding:8px;border-radius:var(--dsw-radius-xl);}',
      '@media (hover:hover){.sk-cardHead:hover{background:var(--dsw-alias-interactive-bg-hover);}}',
      '.sk-cardHit{display:flex;align-items:center;gap:14px;flex:1;min-width:0;margin:0;padding:0;',
      'border:0;background:0 0;font:inherit;color:inherit;text-align:left;cursor:pointer;border-radius:var(--dsw-radius-lg);}',
      '.sk-cardHit:focus-visible{outline:none;}',
      '.sk-cardHit:focus-visible .sk-cardOpen{text-decoration:underline;}',
      '.sk-cardIcon{width:48px;height:48px;flex:none;display:inline-flex;align-items:center;',
      'justify-content:center;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);',
      'color:var(--dsw-alias-label-secondary);}',
      '.sk-cardMain{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0;}',
      '.sk-titleRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;}',
      '.sk-cardOpen{max-width:100%;padding:0;border:0;background:0 0;font-size:14px;font-weight:500;',
      'line-height:20px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace, SFMono-Regular, Menlo, monospace);}',
      '.sk-cardDesc{font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary);',
      'display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;}',
      '.sk-cardEnd{display:inline-flex;align-items:center;gap:10px;flex:none;position:relative;z-index:1;}',
      '.sk-cardArrow{display:inline-flex;color:var(--dsw-alias-label-tertiary);}',
      '.sk-tag{flex:none;display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;',
      'font-size:10px;line-height:1;white-space:nowrap;border:.5px solid var(--dsw-alias-border-l3);',
      'color:var(--dsw-alias-label-secondary);}',
      '.sk-tag[data-muted="true"]{color:var(--dsw-alias-label-tertiary);}',
      '.sk-statusLine{margin:24px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);}',
      '.sk-empty{display:flex;flex-direction:column;gap:8px;margin-top:24px;font-size:13px;line-height:20px;',
      'color:var(--dsw-alias-label-tertiary);}',
      '.sk-dir{font-family:var(--dsw-font-mono,ui-monospace, SFMono-Regular, Menlo, monospace);font-size:12px;',
      'background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:2px 6px;align-self:flex-start;',
      'max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sk-detail{display:flex;flex-direction:column;}',
      '.sk-detailTop{padding-top:28px;}',
      '.sk-crumb{display:inline-flex;align-items:center;gap:6px;padding:0;border:0;background:0 0;',
      'font:inherit;font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer;}',
      '.sk-crumb:hover{color:var(--dsw-alias-label-primary);}',
      '.sk-crumb:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));',
      'outline-offset:2px;}',
      '.sk-crumbIcon{display:inline-flex;transform:rotate(90deg);}',
      '.sk-detailHead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:32px;}',
      '.sk-detailIcon{width:48px;height:48px;flex:none;display:inline-flex;align-items:center;',
      'justify-content:center;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);',
      'color:var(--dsw-alias-label-secondary);}',
      '.sk-detailActions{display:flex;align-items:center;gap:12px;}',
      '.sk-state{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.sk-detailMain{display:flex;flex-direction:column;gap:8px;min-width:0;margin-top:20px;}',
      '.sk-detailTitle{margin:0;font-size:20px;font-weight:500;line-height:28px;overflow-wrap:anywhere;}',
      '.sk-detailDesc{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary);}',
      '.sk-detailName{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);',
      'overflow-wrap:anywhere;}',
      '.sk-detailName code{font-family:var(--dsw-font-mono,ui-monospace, SFMono-Regular, Menlo, monospace);}',
      '.sk-sections{display:flex;flex-direction:column;gap:32px;margin-top:32px;}',
      '.sk-section{display:flex;flex-direction:column;gap:12px;}',
      '.sk-sectionHead{display:flex;align-items:center;gap:10px;}',
      '.sk-sectionTitle{margin:0;font-size:14px;font-weight:500;line-height:20px;}',
      '.sk-sectionAction{flex:none;margin-left:auto;white-space:nowrap;}',
      '.sk-facts{margin:0;}',
      '.sk-fact{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:44px;',
      'padding:8px 2px;border-bottom:.5px solid var(--dsw-alias-border-l2);}',
      '.sk-fact:last-child{border-bottom:0;}',
      '.sk-fact dt{flex:none;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
      '.sk-fact dd{margin:0;min-width:0;text-align:end;overflow-wrap:anywhere;font-size:13px;line-height:20px;}',
      '.sk-fact code{font-family:var(--dsw-font-mono,ui-monospace, SFMono-Regular, Menlo, monospace);',
      'font-size:12px;background:var(--dsw-alias-bg-module-platform);border-radius:4px;padding:2px 6px;}',
      '.sk-prose{margin:0;font-size:13.5px;line-height:21px;color:var(--dsw-alias-label-secondary);',
      'white-space:pre-wrap;overflow-wrap:anywhere;}',
      '.sk-code{margin:0;max-height:440px;overflow:auto;white-space:pre-wrap;word-break:break-word;',
      'font-family:var(--dsw-font-mono,ui-monospace, SFMono-Regular, Menlo, monospace);font-size:12px;',
      'line-height:1.6;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);',
      'border-radius:var(--dsw-radius-lg);padding:12px 14px;}',
      '.sk-fileNotice{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);}',
      '.sk-fallbackButton{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);',
      'color:inherit;font:inherit;font-size:12px;line-height:20px;height:28px;padding:0 10px;cursor:pointer;white-space:nowrap;}',
      '.sk-fallbackSwitch{position:relative;width:34px;height:20px;border-radius:999px;border:0;padding:0;',
      'background:var(--dsw-alias-bg-layer-2);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1);cursor:pointer;}',
      '.sk-fallbackSwitch.is-on{background:var(--dsw-alias-brand-primary);box-shadow:none;}',
      '.sk-fallbackSwitch:disabled{opacity:.45;cursor:default;}',
      '.sk-fallbackKnob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;',
      'background:#fff;transition:transform .15s ease;}',
      '.sk-fallbackSwitch.is-on .sk-fallbackKnob{transform:translateX(14px);}',
      '.sk-fallbackChevron{display:inline-block;width:7px;height:7px;border-right:1.5px solid currentColor;',
      'border-bottom:1.5px solid currentColor;transform:rotate(-45deg);}',
    ].join('');

    function Style() {
      return h('style', null, CSS);
    }

    // -----------------------------------------------------------------------
    // Fallbacks
    // -----------------------------------------------------------------------

    function FallbackButton(props) {
      const rest = Object.assign({}, props);
      delete rest.variant;
      delete rest.size;
      delete rest.children;
      return h(
        'button',
        Object.assign({ type: 'button' }, rest, {
          className: 'sk-fallbackButton ' + (props.className || ''),
        }),
        props.children,
      );
    }

    function FallbackSwitch(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': props.checked ? 'true' : 'false',
          'aria-label': props.label,
          title: props.title,
          disabled: props.disabled,
          className: 'sk-fallbackSwitch' + (props.checked ? ' is-on' : '') + (props.className ? ' ' + props.className : ''),
          onClick: () => props.onChange(!props.checked),
        },
        h('span', { className: 'sk-fallbackKnob' }),
      );
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function replace(template, values) {
      return template.replace(/\{(\w+)\}/g, (match, key) =>
        values && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
      );
    }

    function sourceKey(source) {
      if (source === 'project-dsh' || source === 'project-agents') return 'badge.project';
      if (source === 'user-dsh' || source === 'user-agents') return 'badge.user';
      if (source === 'custom') return 'badge.custom';
      if (source === 'bundled') return 'badge.bundled';
      if (source === 'runtime') return 'badge.runtime';
      return null;
    }

    function stateKey(skill) {
      if (skill.mixed) return 'badge.mixed';
      return skill.enabled ? 'switchOn' : 'switchOff';
    }

    function icon(size) {
      return IconSkill === null ? null : h(IconSkill, { size, 'aria-hidden': true });
    }

    function Tag(props) {
      return h('span', { className: 'sk-tag', 'data-muted': props.muted ? 'true' : undefined }, props.children);
    }

    function copyText(text) {
      const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
      if (clipboard && typeof clipboard.writeText === 'function') {
        return clipboard.writeText(text);
      }
      return new Promise((resolve, reject) => {
        try {
          const area = document.createElement('textarea');
          area.value = text;
          area.setAttribute('readonly', 'readonly');
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(area);
          if (ok) resolve();
          else reject(new Error('copy failed'));
        } catch (error) {
          reject(error);
        }
      });
    }

    // -----------------------------------------------------------------------
    // List level
    // -----------------------------------------------------------------------

    function SkillCard(props) {
      const { skill, t, pending, onOpen, onToggle } = props;
      const source = sourceKey(skill.source);
      const busy = pending === skill.path;
      return h(
        'li',
        { className: 'sk-card' },
        h(
          'div',
          { className: 'sk-cardHead' },
          h(
            'button',
            {
              type: 'button',
              className: 'sk-cardHit',
              title: replace(t('openDetail'), { name: skill.name }),
              onClick: () => onOpen(skill),
            },
            h('span', { className: 'sk-cardIcon' }, icon(24)),
            h(
              'span',
              { className: 'sk-cardMain' },
              h(
                'span',
                { className: 'sk-titleRow' },
                h('span', { className: 'sk-cardOpen' }, skill.name),
                source === null ? null : h(Tag, null, t(source)),
                skill.manageable ? null : h(Tag, { muted: true }, t('badge.readonly')),
                skill.mixed ? h(Tag, null, t('badge.mixed')) : null,
              ),
              skill.description ? h('span', { className: 'sk-cardDesc' }, skill.description) : null,
            ),
          ),
          h(
            'span',
            { className: 'sk-cardEnd' },
            h(Switch, {
              checked: skill.enabled,
              label: replace(t('switchLabel'), { name: skill.name }),
              title: skill.manageable ? undefined : t('readonlyHint'),
              disabled: !skill.manageable || busy,
              onChange: (next) => onToggle(skill, next),
            }),
            h('span', { className: 'sk-cardArrow' }, IconChevronRight === null ? null : h(IconChevronRight, { size: 16, 'aria-hidden': true })),
          ),
        ),
      );
    }

    function ListPage(props) {
      const { t, data, skills, busy, notice, onRefresh, onOpen, onToggle, pending } = props;
      const groups = ['project', 'user', 'bundled', 'other'];
      const counts = data.counts || { total: skills.length, manageable: 0, enabled: 0 };
      return h(
        'div',
        null,
        h(
          'header',
          { className: 'sk-head' },
          h(
            'div',
            { className: 'sk-heading' },
            h('h1', { className: 'sk-title' }, t('title')),
            h('p', { className: 'sk-intro' }, t('subtitle')),
          ),
          h(
            'div',
            { className: 'sk-toolbar' },
            h('span', { className: 'sk-stats' }, replace(t('stats'), counts)),
            h(
              Button,
              { variant: 'outline', size: 'sm', disabled: busy, onClick: onRefresh },
              busy ? t('refreshing') : t('refresh'),
            ),
          ),
        ),
        data.complete === false ? h('p', { className: 'sk-warn' }, t('incomplete')) : null,
        notice === null ? null : h('p', { className: 'sk-error' }, notice),
        skills.length === 0
          ? h(
              'div',
              { className: 'sk-empty' },
              h('span', null, t('empty')),
              h('span', null, t('emptyHint')),
              data.dirs && data.dirs.user ? h('code', { className: 'sk-dir' }, data.dirs.user) : null,
              data.dirs && data.dirs.project ? h('code', { className: 'sk-dir' }, data.dirs.project) : null,
            )
          : h(
              'div',
              { className: 'sk-groups' },
              groups.map((group) => {
                const members = skills.filter((skill) => (skill.group || 'other') === group);
                if (members.length === 0) return null;
                return h(
                  'section',
                  { className: 'sk-group', key: group },
                  h(
                    'h2',
                    { className: 'sk-groupTitle' },
                    t('group.' + group),
                    h('span', { className: 'sk-groupCount' }, String(members.length)),
                  ),
                  h(
                    'ul',
                    { className: 'sk-cards' },
                    members.map((skill) =>
                      h(SkillCard, {
                        key: skill.name,
                        skill,
                        t,
                        pending,
                        onOpen,
                        onToggle,
                      }),
                    ),
                  ),
                );
              }),
            ),
      );
    }

    // -----------------------------------------------------------------------
    // Detail level
    // -----------------------------------------------------------------------

    function FactRow(props) {
      return h('div', { className: 'sk-fact' }, h('dt', null, props.label), h('dd', null, props.children));
    }

    function DetailPage(props) {
      const { t, skill, pending, file, copied, notice, onBack, onToggle, onCopy } = props;
      const source = sourceKey(skill.source);
      const busy = pending === skill.path;
      const yes = t('yes');
      const no = t('no');
      return h(
        'div',
        { className: 'sk-detail' },
        h(
          'div',
          { className: 'sk-detailTop' },
          h(
            'button',
            { type: 'button', className: 'sk-crumb', 'aria-label': t('backToList'), onClick: onBack },
            h('span', { className: 'sk-crumbIcon' }, IconChevronDown === null ? null : h(IconChevronDown, { size: 16, 'aria-hidden': true })),
            h('span', null, t('crumb')),
          ),
          h(
            'div',
            { className: 'sk-detailHead' },
            h('span', { className: 'sk-detailIcon' }, icon(26)),
            h(
              'div',
              { className: 'sk-detailActions' },
              h('span', { className: 'sk-state' }, skill.mixed ? t('badge.mixed') : skill.enabled ? t('switchOn') : t('switchOff')),
              h(Switch, {
                checked: skill.enabled,
                label: replace(t('switchLabel'), { name: skill.name }),
                title: skill.manageable ? undefined : t('readonlyHint'),
                disabled: !skill.manageable || busy,
                onChange: (next) => onToggle(skill, next),
              }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'sk-detailMain' },
          h(
            'div',
            { className: 'sk-titleRow' },
            h('h2', { className: 'sk-detailTitle' }, skill.name),
            source === null ? null : h(Tag, null, t(source)),
            skill.manageable ? null : h(Tag, { muted: true }, t('badge.readonly')),
          ),
          skill.description ? h('p', { className: 'sk-detailDesc' }, skill.description) : null,
          skill.path ? h('p', { className: 'sk-detailName' }, h('code', null, skill.path)) : null,
          notice === null ? null : h('p', { className: 'sk-error' }, notice),
        ),
        h(
          'div',
          { className: 'sk-sections' },
          h(
            'section',
            { className: 'sk-section' },
            h('div', { className: 'sk-sectionHead' }, h('h3', { className: 'sk-sectionTitle' }, t('sectionContract'))),
            h(
              'dl',
              { className: 'sk-facts' },
              h(FactRow, { label: t('fact.source') }, source === null ? skill.source || '—' : t(source)),
              typeof skill.provider === 'string' && skill.provider.length > 0
                ? h(FactRow, { label: t('fact.provider') }, h('code', null, skill.provider))
                : null,
              h(FactRow, { label: t('fact.model') }, skill.modelInvocable ? yes : no),
              h(FactRow, { label: t('fact.user') }, skill.userInvocable ? yes : no),
              h(FactRow, { label: t('fact.manage') }, skill.manageable ? yes : no),
            ),
          ),
          typeof skill.whenToUse === 'string' && skill.whenToUse.length > 0
            ? h(
                'section',
                { className: 'sk-section' },
                h('div', { className: 'sk-sectionHead' }, h('h3', { className: 'sk-sectionTitle' }, t('sectionWhen'))),
                h('p', { className: 'sk-prose' }, skill.whenToUse),
              )
            : null,
          h(
            'section',
            { className: 'sk-section' },
            h(
              'div',
              { className: 'sk-sectionHead' },
              h('h3', { className: 'sk-sectionTitle' }, t('sectionFile')),
              skill.path
                ? h(
                    Button,
                    {
                      variant: 'ghost',
                      size: 'sm',
                      className: 'sk-sectionAction',
                      disabled: file.phase !== 'ready',
                      onClick: () => onCopy(),
                    },
                    IconCopy === null ? null : h(IconCopy, { size: 16, 'aria-hidden': true }),
                    h('span', null, copied ? t('copied') : t('copy')),
                  )
                : null,
            ),
            file.phase === 'ready'
              ? h('pre', { className: 'sk-code' }, file.content)
              : file.phase === 'error'
                ? h('p', { className: 'sk-error' }, replace(t('fileFailed'), { message: file.message }))
                : h('p', { className: 'sk-fileNotice' }, skill.path ? t('fileLoading') : t('noPath')),
          ),
        ),
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
      const [selected, setSelected] = React.useState(null);
      const [file, setFile] = React.useState({ phase: 'idle' });
      const [notice, setNotice] = React.useState(null);
      const [copied, setCopied] = React.useState(false);
      const bodyRef = React.useRef(null);
      const fileSeq = React.useRef(0);

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

      React.useEffect(() => {
        if (selected === null) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          setSelected(null);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [selected]);

      React.useEffect(() => {
        const body = bodyRef.current;
        if (body !== null) body.scrollTop = 0;
      }, [selected]);

      const skills = data !== null && Array.isArray(data.skills) ? data.skills : [];
      const current = selected === null ? null : skills.find((skill) => skill.name === selected) || null;

      React.useEffect(() => {
        if (selected !== null && phase === 'ready' && current === null) setSelected(null);
      }, [selected, phase, current]);

      const refresh = () => setAttempt((value) => value + 1);

      const openSkill = (skill) => {
        setSelected(skill.name);
        setNotice(null);
        setCopied(false);
        const seq = fileSeq.current + 1;
        fileSeq.current = seq;
        if (!skill.path) {
          setFile({ phase: 'none' });
          return;
        }
        setFile({ phase: 'loading' });
        request(FILE + '?path=' + encodeURIComponent(skill.path)).then(
          (value) => {
            if (fileSeq.current === seq) setFile({ phase: 'ready', content: value.content });
          },
          (error) => {
            if (fileSeq.current !== seq) return;
            setFile({ phase: 'error', message: error && error.message ? error.message : String(error) });
          },
        );
      };

      const back = () => setSelected(null);

      const toggle = (skill, next) => {
        if (!skill || !skill.path) return;
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

      const copy = () => {
        if (file.phase !== 'ready') return;
        copyText(file.content).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          },
          () => setCopied(false),
        );
      };

      const head = h(
        'div',
        { className: 'sk-head' },
        h(
          'div',
          { className: 'sk-heading' },
          h('h1', { className: 'sk-title' }, t('title')),
          h('p', { className: 'sk-intro' }, t('subtitle')),
        ),
        h(
          'div',
          { className: 'sk-toolbar' },
          h(
            Button,
            { variant: 'outline', size: 'sm', disabled: busy, onClick: refresh },
            busy ? t('refreshing') : t('refresh'),
          ),
        ),
      );

      let content;
      if (data === null && phase === 'error') {
        const code = failure ? failure.code : undefined;
        const message =
          code === 'unauthorized'
            ? t('authFailed')
            : code === undefined
              ? t('offline')
              : replace(t('loadFailed'), { message: failure && failure.message ? failure.message : String(code) });
        content = h(
          'div',
          null,
          head,
          h(
            'div',
            { className: 'sk-empty' },
            h('p', { className: 'sk-error' }, message),
            h(Button, { variant: 'outline', size: 'sm', onClick: refresh }, t('retry')),
          ),
        );
      } else if (data === null) {
        content = h('div', null, head, h('p', { className: 'sk-statusLine' }, t('loading')));
      } else if (current !== null) {
        content = h(DetailPage, {
          t,
          skill: current,
          pending,
          file,
          copied,
          notice,
          onBack: back,
          onToggle: toggle,
          onCopy: copy,
        });
      } else {
        content = h(ListPage, {
          t,
          data,
          skills,
          busy,
          pending,
          notice,
          onRefresh: refresh,
          onOpen: openSkill,
          onToggle: toggle,
        });
      }

      return h('div', { className: 'sk-page' }, h(Style), h('div', { className: 'sk-body', ref: bodyRef }, content));
    }

    // -----------------------------------------------------------------------
    // Sidebar glyph
    // -----------------------------------------------------------------------

    function SkillsPanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16;
      if (IconSkill !== null) return h(IconSkill, { size, 'aria-hidden': true });
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
