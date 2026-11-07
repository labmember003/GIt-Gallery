import React, { useEffect, useState } from 'react';
import { View, FlatList } from 'react-native';
import { Button, Text, TextInput, List, ActivityIndicator, useTheme } from 'react-native-paper';
import { useAppStore } from '@/store/appState';
import { Octokit } from '@octokit/rest';

export default function RepoSetupScreen({ navigation }: any) {
  const token = useAppStore((s) => s.authToken);
  const setCurrentRepo = useAppStore((s) => s.setCurrentRepo);
  const theme = useTheme();
  const [loading, setLoading] = useState(false);
  const [repos, setRepos] = useState<any[]>([]);
  const [newRepoName, setNewRepoName] = useState('gitgallery-photos');
  const [error, setError] = useState<string | null>(null);

  const octokit = React.useMemo(() => {
    return new Octokit({ 
      auth: token || undefined,
      log: {
        debug: () => {},
        info: () => {},
        warn: (message: string, ...args: any[]) => {
          if (typeof message === 'string' && (message.includes('404') || message.includes('Not Found'))) {
            return;
          }
          console.warn(message, ...args);
        },
        error: (message: string, ...args: any[]) => {
          if (typeof message === 'string' && (message.includes('404') || message.includes('Not Found'))) {
            return;
          }
          const error = args[0];
          if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
            return;
          }
          console.error(message, ...args);
        },
      },
    });
  }, [token]);

  async function loadRepos() {
    if (!token) return;
    setLoading(true);
    try {
      const res = await octokit.rest.repos.listForAuthenticatedUser({ visibility: 'private', per_page: 30 });
      setRepos(res.data);
    } catch {
      setError('Could not load your repositories. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  async function createRepo() {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await octokit.rest.repos.createForAuthenticatedUser({
        name: newRepoName,
        description: 'Private repo for GitGallery',
        private: true,
        auto_init: true,
      });
      const repo = res.data;
      setCurrentRepo({ owner: repo.owner!.login, name: repo.name, branch: 'main' });
      leaveSetup();
    } catch (e: any) {
      const nameTaken = e?.status === 422 && e?.response?.data?.errors?.some((x: any) => /already exists/i.test(x?.message ?? ''));
      setError(
        nameTaken
          ? `You already have a repository named "${newRepoName}". Select it below or choose another name.`
          : 'Could not create the repository. Check your connection and try again.',
      );
    } finally {
      setLoading(false);
    }
  }

  function selectRepo(repo: any) {
    setCurrentRepo({ owner: repo.owner.login, name: repo.name, branch: repo.default_branch || 'main' });
    leaveSetup();
  }

  // During onboarding the root navigator swaps in Main by itself once a repo is set and has no
  // Main route to reset to yet. Opened from Settings, Main already exists, so return to it.
  function leaveSetup() {
    let top: any = navigation;
    while (top?.getParent && top.getParent()) top = top.getParent();
    if (top?.getState?.()?.routeNames?.includes('Main')) top.reset({ index: 0, routes: [{ name: 'Main' }] });
  }

  useEffect(() => {
    loadRepos();
  }, []);

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Text variant="titleMedium" style={{ marginBottom: 8 }}>Create new private repo</Text>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 16 }}>
        <TextInput mode="outlined" style={{ flex: 1 }} value={newRepoName} onChangeText={setNewRepoName} />
        <Button mode="contained" onPress={createRepo} loading={loading}>Create</Button>
      </View>
      {error ? <Text style={{ color: theme.colors.error, marginBottom: 16 }}>{error}</Text> : null}

      <Text variant="titleMedium" style={{ marginBottom: 8 }}>Or select existing private repo</Text>
      {loading ? (
        <ActivityIndicator />
      ) : (
        <FlatList
          data={repos}
          keyExtractor={(item) => item.id.toString()}
          renderItem={({ item }) => (
            <List.Item
              title={item.full_name}
              description={item.description}
              onPress={() => selectRepo(item)}
              left={(props) => <List.Icon {...props} icon="source-repository" />}
            />
          )}
        />
      )}
    </View>
  );
}


