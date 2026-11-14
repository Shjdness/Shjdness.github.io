import Editor from '@monaco-editor/react';
import _ from 'lodash';
import { editor } from 'monaco-editor';
import { Calendar } from 'primereact/calendar';
import 'primereact/resources/primereact.css';
import 'primereact/resources/themes/lara-light-indigo/theme.css';
import React, { useEffect, useRef, useState, useCallback } from "react";
import { Helmet } from "react-helmet";
import { useTranslation } from "react-i18next";
import Loading from 'react-loading';
import { useAlert, useConfirm } from '../components/dialog';
import { Input } from "../components/input";
import { Markdown } from "../components/markdown";
import { client } from "../main";
import { apiErrorMessage, headersWithAuth } from "../utils/auth";
import { Cache, useCache } from '../utils/cache';
import { siteName } from "../utils/constants";
import { useColorMode } from "../utils/darkModeUtils";
import mermaid from 'mermaid';
import { readingStats } from '../utils/reading';
import { getCookie } from 'typescript-cookie';
import { ProfileContext } from '../state/profile';
import { writingAccountId } from '../utils/writing-access';
import { createWritingRevision, loadWritingRecord } from '../utils/writing-load';
import { completeWritingSave, confirmWritingDraftDeletion } from '../utils/writing-save';
import { maxUploadImageBytes, uploadPrivateMedia } from '../utils/private-media';

type ContentKind = 'article' | 'essay' | 'diary' | 'memo';
type TagScope = 'blog' | 'diary' | 'memo';
const tagScope = (kind: ContentKind): TagScope => kind === 'diary' || kind === 'memo' ? kind : 'blog';

// 写作页面
export function WritingPage({ id }: { id?: number }) {
  const profile = React.useContext(ProfileContext);
  const ownerId = writingAccountId(profile, getCookie('token'));
  if (ownerId === null) {
    return <p role="status">请先登录有写作权限的账号。本地稿件已保留。</p>;
  }
  return <WritingEditor key={`${ownerId}:${id ?? 'new'}`} id={id} ownerId={ownerId} />;
}

function WritingEditor({ id, ownerId }: { id?: number; ownerId: number }) {
  const { t } = useTranslation();
  const profile = React.useContext(ProfileContext);
  const editorSession = getCookie('token');
  const colorMode = useColorMode();
  const cache = Cache.forAccount(ownerId, id);
  const revision = useRef(createWritingRevision()).current;
  const loadCheckpoint = useRef(revision.checkpoint()).current;
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const editorRef = useRef<editor.IStandaloneCodeEditor>();
  const [title, storeTitle] = cache.useCache("title", "");
  const [summary, storeSummary] = cache.useCache("summary", "");
  const [tags, storeTags] = cache.useCache("tags", "");
  const [kind, storeKind] = cache.useCache<ContentKind>('kind', 'article');
  const setTitle = revision.track('title', storeTitle);
  const setSummary = revision.track('summary', storeSummary);
  const setTags = revision.track('tags', storeTags);
  const setKind = revision.track('kind', storeKind);
  const tagsByScope = useRef<Record<TagScope, string>>({ blog: tagScope(kind) === 'blog' ? tags : '', diary: kind === 'diary' ? tags : '', memo: kind === 'memo' ? tags : '' });
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [tagQuery, setTagQuery] = useState('');
  const [currentId, setCurrentId] = useState<number | undefined>(id);
  const [recordLoaded, setRecordLoaded] = useState(id === undefined);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [recordLoadFailed, setRecordLoadFailed] = useState(false);
  const [saveState, setSaveState] = useState(id === undefined ? '本地已保存' : '正在载入原记录，本地修改会保留');
  const [content, storeContent] = cache.useCache("content", "");
  const [createdAt, storeCreatedAt] = useState<Date | undefined>(new Date());
  const setContent = revision.track('content', storeContent);
  const setCreatedAt = revision.track('createdAt', storeCreatedAt);
  const [preview, setPreview] = useCache<'edit' | 'preview' | 'comparison'>("preview", 'edit');
  const [uploading, setUploading] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [loadedDraft, setLoadedDraft] = useState(false)
  const [recordWasPublic, setRecordWasPublic] = useState(false);
  const [recordOwner, setRecordOwner] = useState<number>();
  const { showAlert, AlertUI } = useAlert()
  const { showConfirm, ConfirmUI } = useConfirm()
  const restoreLegacy = () => {
    if (profile?.role !== 'owner' || writingAccountId(profile, getCookie('token')) !== ownerId) return;
    showConfirm('恢复旧版草稿', '只有确认这份旧版浏览器草稿属于当前账号时才继续。恢复会替换编辑器里的内容。', () => {
      if (writingAccountId(profile, getCookie('token')) !== ownerId) return;
      const legacy = Cache.with(id);
      const oldTitle = legacy.get('title'), oldContent = legacy.get('content');
      if (oldTitle === null && oldContent === null) {
        showAlert('这篇文章没有旧版浏览器草稿。');
        return;
      }
      const oldKind = legacy.get('kind');
      const oldTags = legacy.get('tags') ?? '';
      setTitle(oldTitle ?? '');
      setContent(oldContent ?? '');
      setSummary(legacy.get('summary') ?? '');
      if (oldKind === 'article' || oldKind === 'essay' || oldKind === 'diary' || oldKind === 'memo') setKind(oldKind);
      tagsByScope.current[tagScope(oldKind === 'article' || oldKind === 'essay' || oldKind === 'diary' || oldKind === 'memo' ? oldKind : kind)] = oldTags;
      setTags(oldTags);
      setSaveState('旧版草稿已复制到当前账号');
    });
  };
  const stats = readingStats(content)

  const selectedTagNames = tags.split('#').map(tag => tag.trim()).filter(Boolean);
  const scope = tagScope(kind);
  const privateMode = kind === 'diary' || kind === 'memo';
  const usePrivateUpload = privateMode || !recordWasPublic;
  const ownsRecord = recordLoaded && (recordOwner === undefined || recordOwner === ownerId);
  const uploadRef = useRef<HTMLInputElement>(null);
  const publicUploadSelected = useRef(false);
  const uploadJob = useRef<AbortController>();
  const uploadIds = useRef(new WeakMap<File, string>());
  const failedUploadIds = useRef(new Map<string, string>());
  useEffect(() => () => { uploadJob.current?.abort(); }, [kind, currentId, recordWasPublic]);
  const saveTagNames = (names: string[]) => {
    const unique = [...new Set(names.map(name => name.trim().replace(/^#/, '')).filter(name => name && name.length <= 64 && !name.includes('#')))];
    const next = unique.map(name => `#${name}`).join(' ');
    tagsByScope.current[scope] = next;
    setTags(next);
  };
  const changeKind = (next: ContentKind) => {
    uploadJob.current?.abort();
    tagsByScope.current[scope] = tags;
    setKind(next);
    setTags(tagsByScope.current[tagScope(next)]);
    if (tagScope(next) !== scope) setAvailableTags([]);
    setTagQuery('');
  };
  const toggleTag = (name: string) => {
    saveTagNames(selectedTagNames.includes(name)
      ? selectedTagNames.filter(tag => tag !== name)
      : [...selectedTagNames, name]);
  };
  const addTypedTag = async () => {
    const name = tagQuery.trim().replace(/^#/, '');
    if (!name) return;
    if (name.length > 64 || name.includes('#') || /[\u0000-\u001f\u007f]/.test(name)) { showAlert('标签需在 64 字以内，且不能包含 # 或控制字符'); return; }
    saveTagNames([...selectedTagNames, name]);
    setAvailableTags(current => [...new Set([...current, name])].sort());
    setTagQuery('');
    try {
      const { error } = await client.tag.options.post({ scope, name }, { headers: headersWithAuth() });
      if (error) throw new Error(String(error.value));
    } catch { showAlert('标签已加入当前内容；目录同步失败，保存内容时会再次同步。'); }
  };

  function applyHeading(level: 1 | 2 | 3) {
    const currentEditor = editorRef.current
    const selection = currentEditor?.getSelection()
    const model = currentEditor?.getModel()
    if (!currentEditor || !selection || !model) return
    const line = selection.startLineNumber
    const currentText = model.getLineContent(line).replace(/^#{1,6}\s*/, '')
    currentEditor.executeEdits('heading-toolbar', [{
      range: {
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: model.getLineMaxColumn(line),
      },
      text: `${'#'.repeat(level)} ${currentText}`,
    }])
    currentEditor.focus()
  }
  async function publishButton() {
    if (publishing || uploadJob.current) return;
    if (!recordLoaded) { setSaveState('原记录尚未成功载入，本地稿已保留，请使用原页重试'); return; }
    const tagsplit =
      tags
        .split("#")
        .filter((tag) => tag !== "")
        .map((tag) => tag.trim()) || [];
    if (!title.trim()) { showAlert(t("title_empty")); return; }
    if (!content.trim()) { showAlert(t("content.empty")); return; }
    if (!privateMode && [title, content, summary].some(value => value.includes('private-media:'))) {
      showAlert('公开文章不能引用私密图片。请移除对应引用，并在需要时用「上传公开配图」重新上传。');
      return;
    }
    const token = getCookie('token');
    const isCurrent = () => live.current && getCookie('token') === token && writingAccountId(profile, token) !== null;
    if (!isCurrent()) return;
    const unchanged = revision.checkpoint();
    const keepEdited = () => setSaveState('本次提交已保存，后续修改仍在本地，请继续保存');
    setPublishing(true);
    try {
      const payload = { title: title.trim(), content, summary, tags: tagsplit, draft: false, kind, listed: !privateMode, createdAt };
      let publishedId = currentId;
      if (currentId !== undefined) {
        const { error } = await client.feed({ id: currentId }).post(payload, { headers: headersWithAuth() });
        if (error) throw new Error(typeof error.value === 'string' ? error.value : JSON.stringify(error.value));
      } else {
        const { data, error } = await client.feed.post(payload, { headers: headersWithAuth() });
        if (error || !data || typeof data === 'string') throw new Error(error ? JSON.stringify(error.value) : '发布失败');
        publishedId = data.insertedId;
      }
      if (!isCurrent()) return;
      setCurrentId(publishedId);
      setLoadedDraft(false);
      setRecordWasPublic(!privateMode);
      if (!unchanged()) { keepEdited(); return; }
      const destination = kind === 'memo' ? '/blog/memos' : kind === 'diary' ? '/blog/diary' : `/blog/feed/${publishedId}`;
      showAlert(currentId === undefined ? t('publish.success') : t('update.success'), () => completeWritingSave({
        isCurrent, unchanged, clear: () => cache.clear(),
        leave: () => { window.location.href = destination; }, onEdited: keepEdited,
      }));
    } catch (error) {
      if (isCurrent()) showAlert(error instanceof Error ? error.message : '发布失败，请稍后重试');
    } finally {
      setPublishing(false);
    }
  }

  async function saveDraftToCloud() {
    if (publishing || uploadJob.current) return;
    if (!recordLoaded) { setSaveState('原记录尚未成功载入，本地稿已保留，请使用原页重试'); return; }
    const token = getCookie('token');
    const isCurrent = () => live.current && getCookie('token') === token && writingAccountId(profile, token) !== null;
    if (!isCurrent()) return;
    const unchanged = revision.checkpoint();
    setPublishing(true); setSaveState('正在上传草稿…');
    const payload = { title: title.trim() || '未命名草稿', content, summary, tags: selectedTagNames, draft: true, kind, listed: false, createdAt };
    try {
      let savedId = currentId;
      if (currentId !== undefined) {
        const { error } = await client.feed({ id: currentId }).post(payload, { headers: headersWithAuth() });
        if (error) throw new Error(String(error.value));
      } else {
        const { data, error } = await client.feed.post(payload, { headers: headersWithAuth() });
        if (error || !data || typeof data === 'string') throw new Error(error ? String(error.value) : '草稿保存失败');
        savedId = data.insertedId;
      }
      if (!isCurrent()) return;
      setCurrentId(savedId);
      setLoadedDraft(true);
      setRecordWasPublic(false);
      completeWritingSave({
        isCurrent, unchanged, clear: () => cache.clear(),
        leave: () => { window.location.href = '/blog/writing'; },
        onEdited: () => setSaveState('本次草稿已保存，后续修改仍在本地，请继续保存'),
      });
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : '云端备份失败，本地稿仍保留';
      setSaveState(message);
      showAlert(message);
    }
    finally { setPublishing(false); }
  }

  function clearWriting() {
    showConfirm('清空写作内容', '标题、正文、摘要和标签都会从当前编辑器中清空。云端草稿不会被删除，除非你另外点击“删除草稿”。', () => {
      uploadJob.current?.abort();
      setTitle('');
      setContent('');
      setSummary('');
      setTags('');
      tagsByScope.current = { blog: '', diary: '', memo: '' };
      setTagQuery('');
      setKind('article');
      setCreatedAt(new Date());
      setSaveState('已清空，尚未保存');
    });
  }

  function deleteCurrentDraft() {
    if (publishing || uploadJob.current || currentId === undefined || !loadedDraft) return;
    const token = getCookie('token');
    const isCurrent = () => live.current && getCookie('token') === token && writingAccountId(profile, token) !== null;
    const unchanged = revision.checkpoint();
    const deletingId = currentId;
    showConfirm('删除云端草稿', '这篇草稿将被永久删除，其他设备也无法恢复。确定继续吗？', async () => {
      setPublishing(true);
      let deleteConfirmed = false;
      try {
        await confirmWritingDraftDeletion({
          isCurrent, unchanged,
          onEdited: () => showAlert('确认期间内容有修改，本地稿已保留，请重新确认是否删除'),
          remove: async () => {
            const { error } = await client.feed({ id: deletingId }).delete(null, { query: { draftOnly: '1' }, headers: headersWithAuth() });
            if (error) throw new Error(typeof error.value === 'string' ? error.value : '删除失败，本地稿已保留');
            deleteConfirmed = true;
          },
          afterDeleted: () => {
            setLoadedDraft(false);
            setRecordWasPublic(false);
            setCurrentId(undefined);
            setRecordOwner(undefined);
            completeWritingSave({
              isCurrent, unchanged, clear: () => cache.clear(),
              leave: () => { window.location.href = '/blog/drafts'; },
              onEdited: () => setSaveState('云端草稿已删除；期间的新输入已保留，可另存为新稿'),
            });
          },
        });
      } catch (error) {
        if (isCurrent()) showAlert(deleteConfirmed ? '云端删除已确认，本地整理未完成；请保留当前页面与内容' : error instanceof Error ? error.message : '删除失败，本地稿已保留');
      } finally {
        setPublishing(false);
      }
    });
  }


  const uploadImages = async (files: File[], explicitlyPublic = false) => {
    if (!files.length || uploadJob.current || publishing || !recordLoaded) return;
    const editor = editorRef.current, model = editor?.getModel();
    const token = getCookie('token');
    const position = editor?.getPosition();
    if (!editor || !model || !position || !token || editorSession !== token || writingAccountId(profile, token) !== ownerId) return;
    const uploadPrivately = usePrivateUpload && !explicitlyPublic;
    if (uploadPrivately && !ownsRecord) {
      showAlert('请由稿件所属账号上传私密图片'); return;
    }
    if (files.length > 12 || files.some(file => !file.size || file.size > maxUploadImageBytes)) {
      showAlert('每次请选择 1 至 12 张图片，单张不超过 5 MiB'); return;
    }
    const controller = new AbortController();
    uploadJob.current = controller;
    setUploading(true);
    const current = () => live.current && !controller.signal.aborted && getCookie('token') === token
      && editorRef.current === editor && editor.getModel() === model;
    const initialVersion = model.getVersionId();
    const images: string[] = [];
    let failure: unknown;
    try {
      for (const file of files) {
        if (!current()) return;
        let url: string;
        if (uploadPrivately) {
          // A picker retry may return a different File instance for the same file.
          // Use its bytes to resume an unconfirmed write within this editor.
          const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), value => value.toString(16).padStart(2, '0')).join('');
          if (!current()) return;
          const operationId = uploadIds.current.get(file) ?? failedUploadIds.current.get(fingerprint) ?? crypto.randomUUID();
          uploadIds.current.set(file, operationId);
          failedUploadIds.current.set(fingerprint, operationId);
          url = await uploadPrivateMedia(file, operationId, controller.signal);
          failedUploadIds.current.delete(fingerprint);
        } else {
          const { data, error } = await client.storage.post({ key: file.name, file }, {
            headers: headersWithAuth(), fetch: { signal: controller.signal },
          });
          if (error || !data) throw Error(apiErrorMessage(error?.value));
          url = data;
        }
        if (!current()) return;
        const alt = file.name.replace(/[\[\]\r\n\\]/g, ' ').slice(0, 240);
        images.push(`![${alt}](${url})\n`);
      }
    } catch (error) {
      failure = error;
    } finally {
      if (current() && images.length) {
        const insertion = model.getVersionId() === initialVersion ? position : model.getPositionAt(model.getValueLength());
        const { lineNumber, column } = insertion;
        const prefix = column > 1 ? '\n' : '';
        editor.executeEdits('image-upload', [{
          range: { startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber, endColumn: column },
          text: prefix + images.join(''),
        }]);
      }
      if (current() && failure) {
        const message = failure instanceof Error ? failure.message : '图片上传未完成，请重试';
        showAlert(images.length ? `已插入 ${images.length} 张图片。其余图片未完成，请仅重选未插入的图片。\n${message}` : message);
      }
      if (uploadJob.current === controller) uploadJob.current = undefined;
      if (live.current) setUploading(false);
    }
  };
  const chooseImages = (forPublic = false) => {
    publicUploadSelected.current = forPublic;
    uploadRef.current?.click();
  };
  useEffect(() => {
    let live = true;
    const cancelled = new AbortController();
    const token = getCookie('token');
    const isCurrent = () => live && getCookie('token') === token && writingAccountId(profile, token) !== null;
    if (id !== undefined) {
      setRecordLoadFailed(false);
      setSaveState('正在载入原记录，本地修改会保留');
      void loadWritingRecord(
        (signal) => client.feed({ id }).get({ headers: headersWithAuth(), fetch: { signal } }),
        isCurrent,
        (data, fieldUnchanged) => {
          if (data.id !== id) throw new Error('Unexpected writing record');
          const hadEdits = !fieldUnchanged();
          if (fieldUnchanged('title')) storeTitle(data.title || '');
          const loadedTags = data.hashtags?.map(({ name }) => `#${name}`).join(" ") || '';
          if (fieldUnchanged('tags') && fieldUnchanged('kind')) {
            tagsByScope.current[tagScope(data.kind as ContentKind)] = loadedTags;
            storeTags(loadedTags);
          }
          if (fieldUnchanged('content')) storeContent(data.content || '');
          if (fieldUnchanged('summary')) storeSummary(data.summary || '');
          if (fieldUnchanged('kind')) storeKind((['article', 'essay', 'diary', 'memo'].includes(data.kind) ? data.kind : 'article') as ContentKind);
          if (fieldUnchanged('createdAt')) storeCreatedAt(new Date(data.createdAt));
          setLoadedDraft(data.draft === 1);
          setRecordWasPublic(data.draft !== 1 && data.kind !== 'diary' && data.kind !== 'memo');
          setRecordOwner(data.uid);
          setRecordLoaded(true);
          if (!hadEdits) setSaveState(data.draft === 1 ? '已从云端载入草稿' : '已从云端载入');
        },
        () => { setRecordLoadFailed(true); setSaveState('云端载入失败，本地稿已保留，可在本页重试'); },
        { unchanged: loadCheckpoint, onChanged: () => setSaveState('云端已载入；载入期间修改的字段已保留，请核对后保存') },
        cancelled.signal,
      );
    }
    return () => { live = false; cancelled.abort(); };
  }, [loadAttempt]);
  useEffect(() => {
    let live = true;
    setAvailableTags([]);
    client.tag.options.get({ query: { scope }, headers: headersWithAuth() }).then(({ data }) => {
      if (live && Array.isArray(data)) setAvailableTags(data.map(tag => tag.name));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [scope]);
  const debouncedUpdate = useCallback(
    _.debounce(() => {
      mermaid.initialize({
        startOnLoad: false,
        theme: "default",
      });
      mermaid.run({
        suppressErrors: true,
        nodes: document.querySelectorAll("pre.mermaid_default")
      }).then(()=>{
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
        });
        mermaid.run({
          suppressErrors: true,
          nodes: document.querySelectorAll("pre.mermaid_dark")
        });
      })
    }, 100),
    []
  );
  useEffect(() => {
    debouncedUpdate();
  }, [content, debouncedUpdate]);
  function MetaInput({ className }: { className?: string }) {
    return (
      <>
        <div className={className}>
          <Input
            id={id}
            value={title}
            setValue={setTitle}
            placeholder={t("title")}
          />
          <label className="writing-kind mt-4">
            <span>内容类型</span>
            <select value={kind} onChange={event => changeKind(event.target.value as ContentKind)}>
              <option value="article">普通文章</option>
              <option value="essay">随笔</option>
              <option value="diary">私人日记</option>
              <option value="memo">备忘录</option>
            </select>
          </label>
          <Input
            id={id}
            value={summary}
            setValue={setSummary}
            placeholder={t("summary")}
            className="mt-4"
          />
          <div className="tag-picker mt-4">
            <div className="tag-picker-heading">
              <span>{t('tags')}</span>
              <small>可多选；输入新词条后按回车即可创建</small>
            </div>
            <div className="tag-picker-options">
              {availableTags.map(name => <span className="tag-picker-option" key={name}>
                <button type="button" onClick={() => toggleTag(name)} aria-pressed={selectedTagNames.includes(name)} className={selectedTagNames.includes(name) ? 'is-selected' : ''}>#{name}</button>
              </span>)}
              {availableTags.length === 0 && <span className="tag-picker-empty">还没有已有标签</span>}
            </div>
            <div className="tag-picker-create">
              <input value={tagQuery} maxLength={65} placeholder="输入新标签" onChange={event => setTagQuery(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void addTypedTag(); } }} />
              <button type="button" onClick={() => void addTypedTag()} disabled={!tagQuery.trim()}>添加</button>
            </div>
            {selectedTagNames.length > 0 && <div className="tag-picker-selected"><span>已选</span>{selectedTagNames.map(name => <button type="button" key={name} onClick={() => toggleTag(name)}>#{name}<i className="ri-close-line" /></button>)}</div>}
          </div>
          <div className="select-none flex flex-row justify-between items-center mt-4 mb-2 pl-4">
            <p className="break-keep mr-2">
              {t('created_at')}
            </p>
            <Calendar value={createdAt} onChange={(e) => setCreatedAt(e.value || undefined)} showTime touchUI hourFormat="24" />
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <Helmet>
        <title>{`${t('writing')} - ${process.env.NAME}`}</title>
        <meta property="og:site_name" content={siteName} />
        <meta property="og:title" content={t('writing')} />
        <meta property="og:image" content={process.env.AVATAR} />
        <meta property="og:type" content="article" />
        <meta property="og:url" content={document.URL} />
      </Helmet>
      <div className="grid grid-cols-1 md:grid-cols-3 t-primary mt-2">
        <div className="col-span-2 pb-8">
          <div className="glass-panel bg-w rounded-2xl shadow-xl shadow-light p-4">
            {MetaInput({ className: "visible md:hidden mb-8" })}
            <div className="flex flex-col mx-4 my-2 md:mx-0 md:my-0 gap-2">
              <div className="flex flex-row flex-wrap items-center gap-2">
                <button className={`${preview === 'edit' ? "text-theme" : ""}`} onClick={() => setPreview('edit')}> {t("edit")} </button>
                <button className={`${preview === 'preview' ? "text-theme" : ""}`} onClick={() => setPreview('preview')}> {t("preview")} </button>
                <button className={`${preview === 'comparison' ? "text-theme" : ""}`} onClick={() => setPreview('comparison')}> {t("comparison")} </button>
                <span className="h-4 w-px bg-neutral-400/40" aria-hidden="true" />
                {[1, 2, 3].map(level => (
                  <button
                    key={level}
                    type="button"
                    className="editor-heading-button"
                    title={t('writing_help.heading', { level })}
                    onClick={() => applyHeading(level as 1 | 2 | 3)}
                  >
                    {'#'.repeat(level)}
                  </button>
                ))}
                <span className="text-xs t-secondary">
                  {t('reading.stats', { count: stats.characters, minutes: stats.minutes })}
                </span>
                <div className="flex-grow" />
                {uploading &&
                  <div className="flex flex-row space-x-2 items-center">
                    <Loading type="spin" color="#FC466B" height={16} width={16} />
                    <span className="text-sm text-neutral-500">{t('uploading')}</span>
                  </div>
                }
              </div>
              <div className={`grid grid-cols-1 ${preview === 'comparison' ? "sm:grid-cols-2" : ""}`}>
                <div className={"flex flex-col " + (preview === 'preview' ? "hidden" : "")}>
                  <div className="flex flex-row justify-start mb-2">
                    <button type="button" aria-label={usePrivateUpload ? '上传私密图片' : '上传公开配图'} disabled={uploading || publishing || !recordLoaded} onClick={() => chooseImages()}>
                      <i className="ri-image-add-line" />
                    </button>
                    {!privateMode && usePrivateUpload && (
                      <button type="button" className="ml-2 px-2 text-sm" disabled={uploading || publishing || !recordLoaded} onClick={() => chooseImages(true)}>
                        上传公开配图
                      </button>
                    )}
                    <input ref={uploadRef} type="file" className="hidden" accept="image/gif,image/jpeg,image/png,image/webp,image/avif" multiple onChange={event => {
                      const input = event.currentTarget;
                      const files = Array.from(input.files ?? []);
                      input.value = '';
                      if (!files.length) return;
                      if (publicUploadSelected.current && !privateMode) {
                        const unchanged = revision.checkpoint();
                        showConfirm('上传公开配图', '图片上传后可通过链接公开访问，即使当前稿件仍是草稿。', () => {
                          if (unchanged()) void uploadImages(files, true);
                        });
                      } else {
                        void uploadImages(files);
                      }
                    }} />
                  </div>
                  <div
                    className={"relative"}
                    onDropCapture={event => {
                      if (!event.dataTransfer.files.length) return;
                      event.preventDefault();
                      event.stopPropagation();
                      void uploadImages(Array.from(event.dataTransfer.files));
                    }}
                    onPasteCapture={event => {
                      if (!event.clipboardData.files.length) return;
                      event.preventDefault();
                      event.stopPropagation();
                      void uploadImages(Array.from(event.clipboardData.files));
                    }}
                  >
                    <Editor
                      onMount={(editor, _) => {
                        editorRef.current = editor
                      }}
                      height="600px"
                      defaultLanguage="markdown"
                      className=""
                      value={content}
                      onChange={(data, _) => {
                        cache.set("content", data ?? "");
                        setContent(data ?? "");
                      }}
                      theme={colorMode === "dark" ? "vs-dark" : "light"}
                      options={{
                        wordWrap: "on",
                        fontSize: 14,
                        fontFamily: "Fira Code",
                        lineNumbers: "off",
                        dragAndDrop: true,
                        pasteAs: { enabled: false },
                        quickSuggestions: false,
                        suggestOnTriggerCharacters: false,
                        wordBasedSuggestions: 'off',
                        inlineSuggest: { enabled: false },
                        parameterHints: { enabled: false },
                        unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false }
                      }}
                    />
                  </div>
                </div>
                <div
                  className={"px-4 h-[600px] overflow-y-scroll " + (preview !== 'edit' ? "" : "hidden")}
                >
                  <Markdown
                    content={content ? content : "> No content now. Write on the left side."}
                    privateMedia={preview !== 'edit' && recordLoaded && editorSession && content.includes('private-media:') ? { token: editorSession, feedId: currentId, allowStaged: ownsRecord } : undefined}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="w-full md:max-w-96 flex flex-col">
          {MetaInput({ className: "hidden md:block glass-panel bg-w rounded-2xl shadow-xl shadow-light p-4 mx-8" })}
          <div className="writing-save-state">{saveState} <a href="/blog/drafts">草稿箱</a></div>
          {profile?.role === 'owner' && <button type="button" className="writing-restore-draft mx-8" onClick={restoreLegacy}>恢复旧版浏览器草稿</button>}
          {recordLoadFailed && !recordLoaded && <button type="button" className="writing-save-draft mx-8" onClick={() => setLoadAttempt(value => value + 1)}>重试载入原记录（保留本地修改）</button>}
          <div className="writing-actions mt-4 mx-8">
            <button onClick={clearWriting} className="writing-clear">清空</button>
            <button onClick={deleteCurrentDraft} disabled={uploading || publishing || !loadedDraft} className="writing-delete-draft">删除草稿</button>
            <button onClick={() => void saveDraftToCloud()} disabled={uploading || publishing || !recordLoaded} className="writing-save-draft">保存草稿</button>
            <button
              onClick={publishButton}
              disabled={uploading || publishing || !recordLoaded}
              className="writing-publish bg-theme text-white rounded-full shadow-xl shadow-light flex flex-row justify-center items-center space-x-2"
            >
              {publishing &&
                <Loading type="spin" height={16} width={16} />
              }
              <span>
                {t('publish.title')}
              </span>
            </button>
          </div>
        </div>
      </div>
      <AlertUI />
      <ConfirmUI />
    </>

  );
}
