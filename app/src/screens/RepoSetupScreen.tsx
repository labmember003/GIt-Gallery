import React, { useEffect, useState } from 'react';
import { View, FlatList } from 'react-native';
import { Button, Text, TextInput, List, ActivityIndicator } from 'react-native-paper';
import { useAppStore } from '@/store/appState';
import { Octokit } from '@octokit/rest';

export default function RepoSetupScreen({ navigation }: any) {
  const token = useAppStore((s) => s.authToken);
  const setCurrentRepo = useAppStore((s) => s.setCurrentRepo);
  const [loading, setLoading] = useState(false);
  const [repos, setRepos] = useState<any[]>([]);
  const [newRepoName, setNewRepoName] = useState('gitgallery-photos');

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
    } finally {
      setLoading(false);
    }
  }

  async function createRepo() {
    if (!token) return;
    setLoading(true);
    try {
      const res = await octokit.rest.repos.createForAuthenticatedUser({
        name: newRepoName,
        description: 'Private repo for GitGallery',
        private: true,
        auto_init: true,
      });
      const repo = res.data;
      setCurrentRepo({ owner: repo.owner!.login, name: repo.name, branch: 'main' });
      // Switch root navigator to Main
      let top: any = navigation;
      while (top?.getParent && top.getParent()) top = top.getParent();
      if (top?.reset) top.reset({ index: 0, routes: [{ name: 'Main' }] });
    } finally {
      setLoading(false);
    }
  }

  function selectRepo(repo: any) {
    setCurrentRepo({ owner: repo.owner.login, name: repo.name, branch: repo.default_branch || 'main' });
    let top: any = navigation;
    while (top?.getParent && top.getParent()) top = top.getParent();
    if (top?.reset) top.reset({ index: 0, routes: [{ name: 'Main' }] });
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


