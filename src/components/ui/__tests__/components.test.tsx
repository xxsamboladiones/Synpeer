import renderer, { act } from 'react-test-renderer';

import {
  Avatar,
  Button,
  Card,
  Divider,
  Header,
  Input,
  Loading,
  Modal,
  Screen,
  Skeleton,
  Text,
} from '../index';
import { ThemeProvider } from '@/styles/theme';

describe('ui components', () => {
  it('exports and renders the required base components', () => {
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <ThemeProvider>
          <Screen>
            <Header title="Insta99" />
            <Card>
              <Avatar label="Nina" />
              <Text>Neon foundation</Text>
              <Input label="Name" value="" onChangeText={() => undefined} />
              <Button label="Continue" onPress={() => undefined} />
              <Divider />
              <Loading label="Loading" />
              <Skeleton width={120} height={16} animated={false} />
            </Card>
            <Modal visible={false} title="Hidden" onClose={() => undefined}>
              <Text>Modal content</Text>
            </Modal>
          </Screen>
        </ThemeProvider>,
      );
    });

    expect(tree!.toJSON()).toBeTruthy();
    act(() => {
      tree.unmount();
    });
  });
});
