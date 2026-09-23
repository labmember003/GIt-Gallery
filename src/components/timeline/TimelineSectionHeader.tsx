import React from 'react';
import { View } from 'react-native';
import { Text, useTheme } from 'react-native-paper';
import { formatDayLabel, formatMonthLabel } from './grouping';

/**
 * Date header for a timeline section.
 *
 * Sizes come from Immich's own header widget rather than being eyeballed:
 *   reference/immich/mobile/lib/presentation/widgets/timeline/header.widget.dart
 *     month -> labelLarge @ 24px
 *     day   -> labelLarge @ 15px
 *   reference/immich/mobile/lib/presentation/widgets/timeline/constants.dart
 *     kTimelineHeaderExtent = 80
 *
 * The month line only appears on the first section of a month, so a long scroll
 * reads as "September → Sat 19 → Fri 18 → …" instead of repeating the month.
 */
export const MONTH_HEADER_HEIGHT = 80;
export const DAY_HEADER_HEIGHT = 44;

type Props = {
  date: Date | null;
  startsMonth: boolean;
};

function TimelineSectionHeaderImpl({ date, startsMonth }: Props) {
  const theme = useTheme();

  if (!date) {
    return (
      <View style={{ height: DAY_HEADER_HEIGHT, justifyContent: 'flex-end', paddingHorizontal: 12, paddingBottom: 8, backgroundColor: theme.colors.surface }}>
        <Text variant="labelLarge" style={{ fontSize: 15, lineHeight: 20, color: theme.colors.onSurfaceVariant }}>
          Unknown date
        </Text>
      </View>
    );
  }

  return (
    <View style={{ backgroundColor: theme.colors.surface }}>
      {startsMonth ? (
        <View style={{ height: MONTH_HEADER_HEIGHT, justifyContent: 'flex-end', paddingHorizontal: 12, paddingBottom: 10 }}>
          <Text variant="labelLarge" style={{ fontSize: 24, lineHeight: 32, fontWeight: '600', color: theme.colors.onSurface }}>
            {formatMonthLabel(date)}
          </Text>
        </View>
      ) : null}
      <View style={{ height: DAY_HEADER_HEIGHT, justifyContent: 'flex-end', paddingHorizontal: 12, paddingBottom: 8 }}>
        <Text variant="labelLarge" style={{ fontSize: 15, lineHeight: 20, color: theme.colors.onSurfaceVariant }}>
          {formatDayLabel(date)}
        </Text>
      </View>
    </View>
  );
}

export const TimelineSectionHeader = React.memo(TimelineSectionHeaderImpl);
