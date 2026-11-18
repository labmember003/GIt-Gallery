import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { ActivityIndicator, Button, Dialog, HelperText, Portal, Searchbar, Text, TextInput, useTheme } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useAppStore } from '@/store/appState';
import { createGitHubClient } from '@/services/sync/githubClient';

/**
 * Pick or create the repository the library lives in.
 *
 * Existing GitGallery libraries are found the same way the web app finds
 * them (server/library-setup.mjs): the default name, or the description the
 * app writes when it creates one. They are offered first, so a returning user
 * is never nudged into creating a second `gitgallery-photos`.
 */

const DEFAULT_NAME = 'gitgallery-photos';
const LIBRARY_DESCRIPTION = 'Private repo for GitGallery';
const MAX_PAGES = 10;

type Repo = {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  default_branch: string;
  updated_at?: string | null;
  owner: { login: string };
};

function isLibrary(repo: Repo): boolean {
  return repo.description === LIBRARY_DESCRIPTION || repo.name.toLowerCase() === DEFAULT_NAME;
}

/** Every repo listed here is private, so the label only says when it last changed. */
function updatedLabel(iso?: string | null): string {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return '';
  if (days === 0) return 'updated today';
  if (days === 1) return 'updated yesterday';
  if (days < 30) return `updated ${days} days ago`;
  return `updated ${new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

export default function RepoSetupScreen({ navigation }: any) {
  // A renewed token is the same sign-in; only signing in or out reloads.
  const signedIn = useAppStore((s) => !!s.authToken);
  const setCurrentRepo = useAppStore((s) => s.setCurrentRepo);
  const current = useAppStore((s) => s.currentRepo);
  const theme = useTheme();
  const colors = theme.colors as typeof theme.colors & { surfaceContainerHigh?: string; surfaceContainerLow?: string };

  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState(DEFAULT_NAME);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [confirmRepo, setConfirmRepo] = useState<Repo | null>(null);

  // Always sends the current token, renewing it like every other GitHub call.
  const octokit = useMemo(() => createGitHubClient({ quiet: true }), []);

  const loadRepos = useCallback(async () => {
    if (!signedIn) return;
    setLoading(true);
    setLoadError(null);
    try {
      const all: Repo[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await octokit.rest.repos.listForAuthenticatedUser({
          visibility: 'private',
          affiliation: 'owner,collaborator,organization_member',
          sort: 'updated',
          per_page: 100,
          page,
        });
        all.push(...(res.data as unknown as Repo[]));
        if (res.data.length < 100) break;
      }
      setRepos(all);
    } catch {
      setLoadError('Could not load your repositories. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [octokit, signedIn]);

  useEffect(() => {
    void loadRepos();
  }, [loadRepos]);

  const libraries = useMemo(() => repos.filter(isLibrary), [repos]);
  const others = useMemo(() => {
    const q = query.trim().toLowerCase();
    return repos
      .filter((r) => !isLibrary(r))
      .filter((r) => !q || r.full_name.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q));
  }, [repos, query]);

  // Never suggest a name the user already has.
  useEffect(() => {
    if (repos.length === 0) return;
    const owned = new Set(repos.map((r) => r.name.toLowerCase()));
    if (!owned.has(newName.trim().toLowerCase())) return;
    let n = 2;
    while (owned.has(`${DEFAULT_NAME}-${n}`)) n++;
    setNewName(`${DEFAULT_NAME}-${n}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos]);

  const nameTaken = useMemo(
    () => repos.find((r) => r.name.toLowerCase() === newName.trim().toLowerCase()) ?? null,
    [repos, newName],
  );

  // During onboarding the root navigator swaps in Main by itself once a repo is set and has no
  // Main route to reset to yet. Opened from Settings, Main already exists, so return to it.
  function leaveSetup() {
    let top: any = navigation;
    while (top?.getParent && top.getParent()) top = top.getParent();
    if (top?.getState?.()?.routeNames?.includes('Main')) top.reset({ index: 0, routes: [{ name: 'Main' }] });
  }

  function isCurrent(repo: Repo): boolean {
    return !!current && current.owner.toLowerCase() === repo.owner.login.toLowerCase() && current.name.toLowerCase() === repo.name.toLowerCase();
  }

  function openRepo(repo: Repo) {
    setCurrentRepo({ owner: repo.owner.login, name: repo.name, branch: repo.default_branch || 'main' });
    leaveSetup();
  }

  async function createRepo() {
    const name = newName.trim();
    if (!signedIn || !name || nameTaken) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await octokit.rest.repos.createForAuthenticatedUser({
        name,
        description: LIBRARY_DESCRIPTION,
        private: true,
        auto_init: true,
      });
      setCurrentRepo({ owner: res.data.owner!.login, name: res.data.name, branch: res.data.default_branch || 'main' });
      leaveSetup();
    } catch (e: any) {
      const exists = e?.status === 422 && e?.response?.data?.errors?.some((x: any) => /already exists/i.test(x?.message ?? ''));
      setCreateError(exists ? `You already have a repository named "${name}".` : 'Could not create the repository. Check your connection and try again.');
    } finally {
      setCreating(false);
    }
  }

  const card = (repo: Repo, primary: boolean) => (
    <Pressable
      key={repo.id}
      onPress={() => (primary ? openRepo(repo) : setConfirmRepo(repo))}
      accessibilityRole="button"
      accessibilityLabel={`${primary ? 'Open' : 'Use'} ${repo.full_name}`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        padding: primary ? 16 : 12,
        marginHorizontal: 16,
        marginBottom: 8,
        borderRadius: 16,
        backgroundColor: primary ? theme.colors.primaryContainer : pressed ? theme.colors.surfaceVariant : 'transparent',
        opacity: pressed && primary ? 0.85 : 1,
      })}
    >
      <MaterialCommunityIcons
        name={primary ? 'image-multiple' : 'source-repository'}
        size={primary ? 28 : 22}
        color={primary ? theme.colors.onPrimaryContainer : theme.colors.onSurfaceVariant}
      />
      <View style={{ flex: 1, marginLeft: 14 }}>
        {/* The repo name leads; the owner moves to the second line so long names aren't cut off. */}
        <Text variant={primary ? 'titleMedium' : 'bodyLarge'} numberOfLines={2} style={{ color: primary ? theme.colors.onPrimaryContainer : theme.colors.onSurface }}>
          {repo.name}
        </Text>
        <Text variant="bodySmall" numberOfLines={2} style={{ color: primary ? theme.colors.onPrimaryContainer : theme.colors.onSurfaceVariant, opacity: primary ? 0.8 : 1 }}>
          {[repo.owner.login, primary ? updatedLabel(repo.updated_at) : repo.description || updatedLabel(repo.updated_at)].filter(Boolean).join(' · ')}
        </Text>
      </View>
      {primary ? (
        isCurrent(repo) ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 8, paddingHorizontal: 4 }} accessibilityLabel="Library in use">
            <MaterialCommunityIcons name="check-circle" size={18} color={theme.colors.primary} />
            <Text variant="labelLarge" style={{ marginLeft: 4, color: theme.colors.primary }}>In use</Text>
          </View>
        ) : (
          <Button mode="contained" compact onPress={() => openRepo(repo)} style={{ borderRadius: 999, marginLeft: 8 }}>Open</Button>
        )
      ) : null}
    </Pressable>
  );

  const createForm = (
    <View style={{ marginHorizontal: 16, marginBottom: 8, padding: 16, borderRadius: 16, backgroundColor: colors.surfaceContainerHigh ?? theme.colors.surfaceVariant }}>
      <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
        {libraries.length > 0 ? 'Create another library' : 'Create your library'}
      </Text>
      <Text variant="bodyMedium" style={{ marginTop: 4, color: theme.colors.onSurfaceVariant }}>
        A private repository in your GitHub account. Only you can see it.
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: 8 }}>
        <TextInput
          mode="outlined"
          dense
          label="Repository name"
          style={{ flex: 1 }}
          value={newName}
          onChangeText={(v) => {
            setNewName(v);
            setCreateError(null);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          error={!!nameTaken}
        />
        <Button mode="contained" onPress={createRepo} loading={creating} disabled={creating || !newName.trim() || !!nameTaken} style={{ borderRadius: 999 }}>
          Create
        </Button>
      </View>
      {nameTaken ? (
        <HelperText type="error" visible style={{ paddingHorizontal: 0 }}>
          You already have "{nameTaken.name}".{' '}
          <Text style={{ color: theme.colors.primary, fontWeight: '600' }} onPress={() => (isLibrary(nameTaken) ? openRepo(nameTaken) : setConfirmRepo(nameTaken))}>
            Open it instead
          </Text>
        </HelperText>
      ) : createError ? (
        <HelperText type="error" visible style={{ paddingHorizontal: 0 }}>{createError}</HelperText>
      ) : null}
    </View>
  );

  const header = (
    <View style={{ paddingTop: 8 }}>
      {loading ? (
        <View style={{ alignItems: 'center', padding: 32 }}>
          <ActivityIndicator />
          <Text variant="bodyMedium" style={{ marginTop: 12, color: theme.colors.onSurfaceVariant }}>Looking for your GitGallery library…</Text>
        </View>
      ) : loadError ? (
        <View style={{ alignItems: 'center', padding: 24 }}>
          <Text variant="bodyMedium" style={{ color: theme.colors.error, textAlign: 'center' }}>{loadError}</Text>
          <Button mode="contained-tonal" onPress={loadRepos} style={{ marginTop: 12 }}>Try again</Button>
        </View>
      ) : (
        <>
          {libraries.length > 0 ? (
            <>
              <Text variant="titleSmall" style={{ marginHorizontal: 20, marginBottom: 8, color: theme.colors.onSurfaceVariant }}>
                {libraries.length === 1 ? 'Your GitGallery library' : 'Your GitGallery libraries'}
              </Text>
              {libraries.map((r) => card(r, true))}
              {showCreate ? createForm : (
                <Button mode="text" icon="plus" onPress={() => setShowCreate(true)} style={{ alignSelf: 'flex-start', marginLeft: 8 }}>
                  Create another library
                </Button>
              )}
            </>
          ) : (
            createForm
          )}
          {repos.some((r) => !isLibrary(r)) ? (
            <>
              <Text variant="titleSmall" style={{ marginHorizontal: 20, marginTop: 16, marginBottom: 8, color: theme.colors.onSurfaceVariant }}>
                Other private repositories
              </Text>
              <Searchbar
                placeholder="Search your repositories"
                value={query}
                onChangeText={setQuery}
                autoCapitalize="none"
                autoCorrect={false}
                style={{ marginHorizontal: 16, marginBottom: 8 }}
                inputStyle={{ minHeight: 0 }}
              />
            </>
          ) : null}
        </>
      )}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
      <FlatList
        data={loading || loadError ? [] : others}
        keyExtractor={(r) => String(r.id)}
        renderItem={({ item }) => card(item, false)}
        ListHeaderComponent={header}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 32 }}
        ListEmptyComponent={
          !loading && !loadError && query.trim() ? (
            <Text variant="bodyMedium" style={{ textAlign: 'center', padding: 24, color: theme.colors.onSurfaceVariant }}>
              No repositories match "{query.trim()}".
            </Text>
          ) : null
        }
      />
      <Portal>
        <Dialog visible={!!confirmRepo} onDismiss={() => setConfirmRepo(null)} style={{ borderRadius: 28, backgroundColor: theme.colors.surface }}>
          <Dialog.Title>Use {confirmRepo?.name} for photos?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              GitGallery will add a gitgallery folder to {confirmRepo?.full_name} and commit your photos there. If this repository holds code or other work, create a separate library instead.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirmRepo(null)}>Cancel</Button>
            <Button
              mode="contained"
              style={{ marginLeft: 8, paddingHorizontal: 8 }}
              onPress={() => {
                const repo = confirmRepo;
                setConfirmRepo(null);
                if (repo) openRepo(repo);
              }}
            >
              Use it
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}
