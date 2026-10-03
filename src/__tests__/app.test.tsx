import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Alert } from 'react-native';

// Real SQLite (better-sqlite3) + the real bundled migrations in place of expo-sqlite.
jest.mock('@/db/client', () => ({
  openAppDatabase: async () => {
    const { createTestDatabase } = jest.requireActual('@/db/testing/test-db');
    return createTestDatabase().db;
  },
}));

const alertSpy = jest.spyOn(Alert, 'alert');
beforeEach(() => alertSpy.mockReset());

const BANNER = 'Preview mode — alarms will not ring. Install the development build.';

describe('app shell (Expo Go preview mode)', () => {
  it('boots with the preview engine, the banner, and an empty Home', async () => {
    renderRouter('./app', { initialUrl: '/' });
    expect((await screen.findAllByText(BANNER)).length).toBeGreaterThan(0);
    expect(screen.getByText('No alarm set')).toBeTruthy();
  });

  it('creates an alarm end-to-end and shows it as the next alarm', async () => {
    const app = renderRouter('./app', { initialUrl: '/' });
    await screen.findByText('No alarm set');
    fireEvent.press(screen.getByText('Add alarm'));
    fireEvent.changeText(await screen.findByLabelText('Alarm label'), 'Gym');
    await act(async () => fireEvent.press(screen.getByLabelText('Save')));
    expect(alertSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(app.getPathname()).toBe('/'));
    await waitFor(() => expect(screen.queryByText('No alarm set')).toBeNull());
    expect(screen.getAllByText(/Gym/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/it will not ring in Expo Go/).length).toBeGreaterThan(0);
  });

  it('opening the editor via deep link and saving returns Home', async () => {
    const app = renderRouter('./app', { initialUrl: '/alarm/new' });
    await screen.findByLabelText('Alarm label');
    await act(async () => fireEvent.press(screen.getByLabelText('Save')));
    await waitFor(() => expect(app.getPathname()).toBe('/'));
  });

  it('edits and deletes an alarm from the editor', async () => {
    const app = renderRouter('./app', { initialUrl: '/' });
    await screen.findByText('No alarm set');
    fireEvent.press(screen.getByText('Add alarm'));
    fireEvent.changeText(await screen.findByLabelText('Alarm label'), 'Run');
    await act(async () => fireEvent.press(screen.getByLabelText('Save')));
    await waitFor(() => expect(screen.queryByText('No alarm set')).toBeNull());

    fireEvent.press(screen.getByText(/^Run ·/));
    await waitFor(() => expect(app.getPathname()).toMatch(/^\/alarm\//));
    alertSpy.mockImplementationOnce((_title, _message, buttons) => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    await act(async () => fireEvent.press(await screen.findByText('Delete alarm')));
    await waitFor(() => expect(app.getPathname()).toBe('/'));
    expect(await screen.findByText('No alarm set')).toBeTruthy();
  });
});
